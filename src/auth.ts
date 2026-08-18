import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";

export const OAUTH_SCOPES = ["gateway:read", "gateway:write"] as const;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

type ClientRecord = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
};

type RefreshTokenRecord = {
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
};

type PersistedState = {
  clients: Record<string, ClientRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
};

export type AccessTokenInfo = {
  clientId: string;
  scopes: string[];
  expiresAt: number;
};

const authorizationCodes = new Map<string, AuthorizationCode>();
let stateLoad: Promise<PersistedState> | undefined;
let persistQueue = Promise.resolve();

export function oauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UNIFIED_MCP_OAUTH_ENABLED === "1";
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function baseUrl(): string {
  return requiredEnv("UNIFIED_MCP_BASE_URL").replace(/\/$/, "");
}

export function resourceUrl(): string {
  return `${baseUrl()}/mcp`;
}

function stateFile(): string {
  return process.env.UNIFIED_MCP_STATE_FILE || "/var/lib/unified-mcp-gateway/oauth-state.json";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function encodeBase64Url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64url");
}

function decodeBase64Url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function secretMatches(received: string): boolean {
  const expected = hashSecret(requiredEnv("UNIFIED_MCP_ADMIN_SECRET"));
  const actual = hashSecret(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function jwtSecret(): Buffer {
  const value = requiredEnv("UNIFIED_MCP_JWT_SECRET");
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("UNIFIED_MCP_JWT_SECRET must be at least 32 bytes");
  }
  return Buffer.from(value, "utf8");
}

function signAccessToken(clientId: string, scopes: string[], resource: string): { token: string; expiresAt: number } {
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      iss: baseUrl(),
      aud: resource,
      sub: "unified-mcp-admin",
      client_id: clientId,
      scope: scopes.join(" "),
      iat: issuedAt,
      exp: expiresAt,
      jti: encodeBase64Url(randomBytes(16)),
    }),
  );
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", jwtSecret()).update(input).digest("base64url");
  return { token: `${input}.${signature}`, expiresAt };
}

export function verifyAccessToken(token: string): AccessTokenInfo | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    if (!header || !payload || !signature) return null;
    const expected = createHmac("sha256", jwtSecret()).update(`${header}.${payload}`).digest();
    const actual = decodeBase64Url(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    const headerJson = JSON.parse(decodeBase64Url(header).toString("utf8")) as { alg?: string; typ?: string };
    if (headerJson.alg !== "HS256" || headerJson.typ !== "JWT") return null;

    const claims = JSON.parse(decodeBase64Url(payload).toString("utf8")) as {
      iss?: string;
      aud?: string;
      sub?: string;
      client_id?: string;
      scope?: string;
      exp?: number;
    };
    if (
      claims.iss !== baseUrl() ||
      claims.aud !== resourceUrl() ||
      claims.sub !== "unified-mcp-admin" ||
      !claims.client_id ||
      !claims.exp ||
      claims.exp <= nowSeconds()
    ) {
      return null;
    }
    const scopes = (claims.scope || "").split(/\s+/).filter(Boolean);
    if (!scopes.includes("gateway:read")) return null;
    return { clientId: claims.client_id, scopes, expiresAt: claims.exp };
  } catch {
    return null;
  }
}

export function hasScope(auth: AccessTokenInfo | null, scope: (typeof OAUTH_SCOPES)[number]): boolean {
  return Boolean(auth?.scopes.includes(scope));
}

async function loadState(): Promise<PersistedState> {
  if (!stateLoad) {
    stateLoad = (async () => {
      try {
        const raw = await readFile(stateFile(), "utf8");
        const parsed = JSON.parse(raw) as PersistedState;
        return { clients: parsed.clients || {}, refreshTokens: parsed.refreshTokens || {} };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { clients: {}, refreshTokens: {} };
      }
    })();
  }
  return stateLoad;
}

async function persistState(state: PersistedState): Promise<void> {
  persistQueue = persistQueue.then(async () => {
    const file = stateFile();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  });
  await persistQueue;
}

export function redirectUriAllowed(uri: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "https:") return false;
    const configuredHosts = (env.UNIFIED_MCP_OAUTH_REDIRECT_HOSTS || "chatgpt.com")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const host = url.hostname.toLowerCase();
    if (!configuredHosts.includes(host)) return false;
    if (host === "chatgpt.com" && /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname)) return true;
    if (env.UNIFIED_MCP_OAUTH_ALLOW_LEGACY_REDIRECT === "1" && url.pathname === "/connector_platform_oauth_redirect") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function normalizeScopes(scope: string | null | undefined): string[] {
  const requested = (scope || "").split(/\s+/).filter(Boolean);
  const effective = requested.length ? requested : ["gateway:read", "offline_access"];
  const allowed = new Set<string>([...OAUTH_SCOPES, "offline_access"]);
  if (effective.some((value) => !allowed.has(value))) throw new Error("invalid_scope");
  if (!effective.includes("gateway:read")) effective.push("gateway:read");
  return [...new Set(effective)];
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateClientRequest(client: ClientRecord | undefined, redirectUri: string): ClientRecord {
  if (!client || !client.redirectUris.includes(redirectUri)) throw new Error("invalid_client");
  return client;
}

async function registerClient(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = JSON.parse((await readBody(req)) || "{}") as {
    client_name?: string;
    redirect_uris?: unknown;
    token_endpoint_auth_method?: string;
  };
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    writeJson(res, 400, { error: "invalid_redirect_uri" });
    return;
  }
  const redirectUris = body.redirect_uris.filter((value): value is string => typeof value === "string");
  if (redirectUris.length !== body.redirect_uris.length || !redirectUris.every((uri) => redirectUriAllowed(uri))) {
    writeJson(res, 400, { error: "invalid_redirect_uri" });
    return;
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    writeJson(res, 400, { error: "invalid_client_metadata" });
    return;
  }
  const state = await loadState();
  const clientId = `umcp_${encodeBase64Url(randomBytes(24))}`;
  const record: ClientRecord = {
    clientId,
    ...(body.client_name ? { clientName: body.client_name.slice(0, 120) } : {}),
    redirectUris,
    createdAt: nowSeconds(),
  };
  state.clients[clientId] = record;
  await persistState(state);
  writeJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: record.createdAt,
    client_name: record.clientName || "ChatGPT",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

function authorizeForm(params: URLSearchParams, errorMessage?: string): string {
  const hidden = [
    "response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource",
  ].map((name) => `<input type="hidden" name="${name}" value="${htmlEscape(params.get(name) || "")}">`).join("\n");
  const scopes = normalizeScopes(params.get("scope")).filter((scope) => scope !== "offline_access");
  const error = errorMessage ? `<p class="error">${htmlEscape(errorMessage)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Unified MCP Gateway</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f6f8fb;color:#10233a;margin:0;display:grid;place-items:center;min-height:100vh}.card{width:min(520px,calc(100% - 32px));background:#fff;border:1px solid #dde5ee;border-radius:18px;padding:28px;box-shadow:0 16px 48px rgba(16,35,58,.08)}h1{margin:0 0 8px;font-size:24px}p{line-height:1.5}.scopes{background:#f6f8fb;border-radius:12px;padding:14px 18px}.scopes li{margin:6px 0}label{display:block;font-weight:600;margin:18px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b7c5d5;border-radius:10px;font:inherit}button{width:100%;margin-top:16px;border:0;border-radius:10px;padding:12px 16px;background:#123d68;color:white;font:inherit;font-weight:700;cursor:pointer}.error{color:#a21919;font-weight:600}.muted{color:#587087;font-size:14px}</style></head><body><main class="card"><h1>Authorize Unified MCP Gateway</h1><p>ChatGPT is requesting access to your private MCP control plane.</p>${error}<ul class="scopes">${scopes.map((scope) => `<li>${htmlEscape(scope)}</li>`).join("")}</ul><form method="post" action="/authorize">${hidden}<label for="access_secret">Gateway passphrase</label><input id="access_secret" name="access_secret" type="password" autocomplete="current-password" required><button type="submit">Authorize ChatGPT</button></form><p class="muted">Provider credentials remain server-side and are never sent to ChatGPT.</p></main></body></html>`;
}

async function validateAuthorizationParams(params: URLSearchParams): Promise<{ client: ClientRecord; scopes: string[] }> {
  const responseType = params.get("response_type");
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const challenge = params.get("code_challenge") || "";
  const challengeMethod = params.get("code_challenge_method") || "";
  const resource = params.get("resource") || "";
  if (responseType !== "code") throw new Error("unsupported_response_type");
  if (!clientId || !redirectUri || !challenge) throw new Error("invalid_request");
  if (challengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error("invalid_request");
  if (resource !== resourceUrl()) throw new Error("invalid_target");
  const state = await loadState();
  return { client: validateClientRequest(state.clients[clientId], redirectUri), scopes: normalizeScopes(params.get("scope")) };
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === "GET") {
    try {
      await validateAuthorizationParams(url.searchParams);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(authorizeForm(url.searchParams));
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" }).end();
    return;
  }
  const params = new URLSearchParams(await readBody(req));
  try {
    const { client, scopes } = await validateAuthorizationParams(params);
    if (!secretMatches(params.get("access_secret") || "")) {
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
      });
      res.end(authorizeForm(params, "Authorization failed."));
      return;
    }
    const code = encodeBase64Url(randomBytes(32));
    authorizationCodes.set(code, {
      clientId: client.clientId,
      redirectUri: params.get("redirect_uri") || "",
      codeChallenge: params.get("code_challenge") || "",
      resource: params.get("resource") || "",
      scopes,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    const callback = new URL(params.get("redirect_uri") || "");
    callback.searchParams.set("code", code);
    const stateValue = params.get("state");
    if (stateValue) callback.searchParams.set("state", stateValue);
    callback.searchParams.set("iss", baseUrl());
    res.writeHead(302, { location: callback.toString(), "cache-control": "no-store" }).end();
  } catch (error) {
    writeJson(res, 400, { error: error instanceof Error ? error.message : "invalid_request" });
  }
}

async function issueRefreshToken(state: PersistedState, clientId: string, resource: string, scopes: string[]): Promise<string> {
  const token = encodeBase64Url(randomBytes(40));
  state.refreshTokens[sha256(token)] = { clientId, resource, scopes, expiresAt: nowSeconds() + REFRESH_TOKEN_TTL_SECONDS };
  await persistState(state);
  return token;
}

async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const params = new URLSearchParams(await readBody(req));
  const grantType = params.get("grant_type") || "";
  const clientId = params.get("client_id") || "";
  const resource = params.get("resource") || "";
  if (!clientId || resource !== resourceUrl()) {
    writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const state = await loadState();
  if (!state.clients[clientId]) {
    writeJson(res, 401, { error: "invalid_client" });
    return;
  }
  if (grantType === "authorization_code") {
    const codeValue = params.get("code") || "";
    const code = authorizationCodes.get(codeValue);
    authorizationCodes.delete(codeValue);
    if (!code || code.expiresAt < Date.now() || code.clientId !== clientId || code.resource !== resource) {
      writeJson(res, 400, { error: "invalid_grant" });
      return;
    }
    if (params.get("redirect_uri") !== code.redirectUri || sha256(params.get("code_verifier") || "") !== code.codeChallenge) {
      writeJson(res, 400, { error: "invalid_grant" });
      return;
    }
    const access = signAccessToken(clientId, code.scopes, resource);
    const refreshToken = await issueRefreshToken(state, clientId, resource, code.scopes);
    writeJson(res, 200, { access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope: code.scopes.join(" ") });
    return;
  }
  if (grantType === "refresh_token") {
    const key = sha256(params.get("refresh_token") || "");
    const existing = state.refreshTokens[key];
    if (!existing || existing.clientId !== clientId || existing.resource !== resource || existing.expiresAt <= nowSeconds()) {
      writeJson(res, 400, { error: "invalid_grant" });
      return;
    }
    delete state.refreshTokens[key];
    const scopes = params.get("scope") ? normalizeScopes(params.get("scope")) : existing.scopes;
    if (scopes.some((scope) => !existing.scopes.includes(scope))) {
      writeJson(res, 400, { error: "invalid_scope" });
      return;
    }
    const access = signAccessToken(clientId, scopes, resource);
    const refreshToken = await issueRefreshToken(state, clientId, resource, scopes);
    writeJson(res, 200, { access_token: access.token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refreshToken, scope: scopes.join(" ") });
    return;
  }
  writeJson(res, 400, { error: "unsupported_grant_type" });
}

export function oauthResourceMetadataUrl(): string {
  return `${baseUrl()}/.well-known/oauth-protected-resource/mcp`;
}

export function oauthChallenge(): string {
  return `Bearer resource_metadata="${oauthResourceMetadataUrl()}", scope="gateway:read"`;
}

export async function handleOAuthRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!oauthEnabled()) return false;
  const path = url.pathname;
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    writeJson(res, 200, {
      resource: resourceUrl(),
      authorization_servers: [baseUrl()],
      scopes_supported: [...OAUTH_SCOPES],
      bearer_methods_supported: ["header"],
    });
    return true;
  }
  if (path === "/.well-known/oauth-authorization-server") {
    writeJson(res, 200, {
      issuer: baseUrl(),
      authorization_endpoint: `${baseUrl()}/authorize`,
      token_endpoint: `${baseUrl()}/token`,
      registration_endpoint: `${baseUrl()}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...OAUTH_SCOPES, "offline_access"],
      authorization_response_iss_parameter_supported: true,
    });
    return true;
  }
  if (path === "/register") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return true;
    }
    try {
      await registerClient(req, res);
    } catch {
      writeJson(res, 400, { error: "invalid_client_metadata" });
    }
    return true;
  }
  if (path === "/authorize") {
    await handleAuthorize(req, res, url);
    return true;
  }
  if (path === "/token") {
    try {
      await handleToken(req, res);
    } catch {
      writeJson(res, 400, { error: "invalid_request" });
    }
    return true;
  }
  return false;
}
