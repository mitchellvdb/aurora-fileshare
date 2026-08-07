#!/usr/bin/env bash
# Run this INSIDE the fileshare container as root.
#
# Expects the release tarball at /root/aurora-fileshare.tar.gz (see
# deploy/make-release.sh), or an existing checkout at /opt/aurora-fileshare.
set -euo pipefail

APP_DIR=/opt/aurora-fileshare
APP_USER=fileshare
NODE_MAJOR=22
TARBALL=/root/aurora-fileshare.tar.gz

echo "==> Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg tar

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
echo "    node $(node --version)"

echo "==> Unpacking application"
mkdir -p "$APP_DIR"
if [ -f "$TARBALL" ]; then
  tar -xzf "$TARBALL" -C "$APP_DIR"
elif [ ! -f "$APP_DIR/package.json" ]; then
  echo "!! No tarball at $TARBALL and no checkout at $APP_DIR" >&2
  exit 1
fi

echo "==> Building"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
# Drop build-only dependencies; the runtime needs just 'ws'.
npm prune --omit=dev

if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "==> Wrote default .env (review it)"
fi

echo "==> Creating service account"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
fi
chown -R root:"$APP_USER" "$APP_DIR"
chmod -R g+rX "$APP_DIR"

echo "==> Installing systemd unit"
install -m 0644 "$APP_DIR/deploy/aurora-fileshare.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aurora-fileshare

sleep 2
if systemctl is-active --quiet aurora-fileshare; then
  echo "==> Service is running"
  curl -fsS http://127.0.0.1:8080/healthz && echo
else
  echo "!! Service failed to start:" >&2
  journalctl -u aurora-fileshare -n 40 --no-pager >&2
  exit 1
fi

cat <<'NEXT'

Application is up on port 8080.

Next: expose it with a Cloudflare Tunnel.
  bash /opt/aurora-fileshare/deploy/setup-tunnel.sh
NEXT
