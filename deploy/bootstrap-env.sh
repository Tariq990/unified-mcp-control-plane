#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE=/etc/unified-mcp-gateway.env

usage() {
  echo "usage: sudo bash deploy/bootstrap-env.sh https://your-mcp-host.example" >&2
  exit 64
}

[[ $# -eq 1 ]] || usage
BASE_URL=${1%/}
[[ "$BASE_URL" =~ ^https://[^/]+$ ]] || { echo "Base URL must be an HTTPS origin with no path" >&2; exit 64; }
[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 77; }
for command in openssl install; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 69; }
done

if [[ -e "$ENV_FILE" ]]; then
  echo "$ENV_FILE already exists; refusing to overwrite secrets." >&2
  exit 73
fi

ADMIN_SECRET="$(openssl rand -base64 36 | tr -d '\n')"
JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

cat >"$TMP" <<EOF
HOST=127.0.0.1
PORT=8788
RECEPIO_MCP_OAUTH_ENABLED=1
RECEPIO_MCP_BASE_URL=$BASE_URL
RECEPIO_MCP_ADMIN_SECRET=$ADMIN_SECRET
RECEPIO_MCP_JWT_SECRET=$JWT_SECRET
RECEPIO_MCP_STATE_FILE=/var/lib/unified-mcp-gateway/oauth-state.json
RECEPIO_MCP_OAUTH_REDIRECT_HOSTS=chatgpt.com
RECEPIO_MCP_OAUTH_ALLOW_LEGACY_REDIRECT=0
RECEPIO_MCP_ALLOW_WRITE=0
RECEPIO_MCP_ALLOW_HIGH_RISK=0
RECEPIO_MCP_ALLOW_DESTRUCTIVE=0
RECEPIO_MCP_ALLOW_PRODUCTION=0
RECEPIO_MCP_GITHUB_TOKEN=
RECEPIO_MCP_GITHUB_REPOSITORIES=Tariq990/unified-mcp-gateway
RECEPIO_MCP_GITHUB_CONTROL_REPOSITORY=Tariq990/unified-mcp-gateway
RECEPIO_MCP_GITHUB_CONTROL_BRANCH=ops/github-control
RECEPIO_MCP_GITHUB_CONTROL_PATH=.recepio/github-control-request.json
RECEPIO_MCP_META_TOKEN=
RECEPIO_MCP_META_GRAPH_VERSION=
RECEPIO_MCP_META_APP_ID=
RECEPIO_MCP_META_WABA_ID=
RECEPIO_MCP_DOWNSTREAM_ALLOWED_HOSTS=
RECEPIO_MCP_DOWNSTREAM_JSON=[]
EOF

install -o root -g root -m 0600 "$TMP" "$ENV_FILE"
unset JWT_SECRET

printf '\nUnified MCP Gateway environment created at %s\n' "$ENV_FILE"
printf 'Save this owner authorization passphrase now; it is shown only by this bootstrap command:\n\n%s\n\n' "$ADMIN_SECRET"
printf 'Provider credentials are intentionally blank. Edit %s as root to enable providers.\n' "$ENV_FILE"
printf 'WRITE/HIGH_RISK/DESTRUCTIVE/PRODUCTION remain disabled by default.\n'
