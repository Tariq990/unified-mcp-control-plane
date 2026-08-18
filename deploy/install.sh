#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: sudo bash deploy/install.sh TARGET_SHA [SOURCE_ROOT]" >&2
  exit 64
}

[[ $# -ge 1 && $# -le 2 ]] || usage
TARGET_SHA=$1
SOURCE_ROOT=${2:-$(git rev-parse --show-toplevel 2>/dev/null || true)}
SERVICE_NAME=unified-mcp-gateway
SERVICE_USER=unified-mcp
SERVICE_GROUP=unified-mcp
ENV_FILE=/etc/unified-mcp-gateway.env
STATE_DIR=/var/lib/unified-mcp-gateway
RELEASES_ROOT=/opt/unified-mcp-gateway/releases
RELEASE_DIR="$RELEASES_ROOT/$TARGET_SHA"
CURRENT_LINK=/opt/unified-mcp-gateway/current
UNIT_TARGET=/etc/systemd/system/unified-mcp-gateway.service

[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 77; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || usage
[[ -n "$SOURCE_ROOT" && -d "$SOURCE_ROOT/.git" ]] || { echo "SOURCE_ROOT must be a Git checkout" >&2; exit 65; }
[[ "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" == "$TARGET_SHA" ]] || {
  echo "Refusing install: checkout HEAD is not TARGET_SHA" >&2
  exit 65
}

for command in node npm rsync curl systemctl install ln; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 69; }
done

[[ -f "$ENV_FILE" ]] || {
  echo "Missing $ENV_FILE; run deploy/bootstrap-env.sh first" >&2
  exit 78
}
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
  groupadd --system "$SERVICE_GROUP"
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --gid "$SERVICE_GROUP" --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0755 /opt/unified-mcp-gateway "$RELEASES_ROOT"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$STATE_DIR"

if [[ ! -d "$RELEASE_DIR" ]]; then
  STAGING="$RELEASES_ROOT/.staging-$TARGET_SHA-$$"
  trap 'rm -rf -- "${STAGING:-}"' EXIT
  rm -rf -- "$STAGING"
  install -d -m 0755 "$STAGING"
  rsync -a --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    "$SOURCE_ROOT/" "$STAGING/"
  (
    cd "$STAGING"
    if [[ -f package-lock.json ]]; then
      npm ci --ignore-scripts --no-fund --no-audit
    else
      npm install --ignore-scripts --no-fund --no-audit
    fi
    npm run check
    npm prune --omit=dev --ignore-scripts
  )
  chown -R root:root "$STAGING"
  chmod -R go-w "$STAGING"
  mv "$STAGING" "$RELEASE_DIR"
  STAGING=""
  trap - EXIT
fi

PREVIOUS_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET=$(readlink -f "$CURRENT_LINK" || true)
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

install -o root -g root -m 0644 \
  "$SOURCE_ROOT/deploy/unified-mcp-gateway.service" \
  "$UNIT_TARGET"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service" >/dev/null

rollback_service() {
  if [[ -n "$PREVIOUS_TARGET" && -d "$PREVIOUS_TARGET" ]]; then
    ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK"
    systemctl restart "$SERVICE_NAME.service" || true
  else
    systemctl stop "$SERVICE_NAME.service" || true
  fi
}
trap 'rc=$?; if [[ $rc -ne 0 ]]; then rollback_service; fi; exit $rc' ERR

systemctl restart "$SERVICE_NAME.service"
for attempt in $(seq 1 20); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8788/health | grep -q '"status":"ok"'; then
    break
  fi
  if [[ "$attempt" -eq 20 ]]; then
    journalctl -u "$SERVICE_NAME.service" -n 80 --no-pager >&2 || true
    echo "MCP localhost health check failed" >&2
    exit 70
  fi
  sleep 1
done
trap - ERR

echo "Unified MCP Gateway is healthy on 127.0.0.1:8788"
echo "PUBLIC_ENDPOINT_BLOCKED: this installer intentionally does not activate public ingress."
echo "Configure DNS/TLS and adapt deploy/nginx.conf.example for your hostname, then verify HTTPS /health and /mcp."
