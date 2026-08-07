#!/usr/bin/env bash
# Exposes the local app at https://fileshare.aurorahosting.nl through a
# Cloudflare Tunnel. Run INSIDE the fileshare container as root.
#
# Two ways to authenticate:
#   A) Dashboard-managed (easiest, no browser needed on this box):
#        create the tunnel at one.dash.cloudflare.com -> Networks -> Tunnels,
#        then:  TUNNEL_TOKEN=eyJ... bash setup-tunnel.sh
#   B) Locally-managed: run without a token and follow the login prompt.
set -euo pipefail

HOSTNAME_FQDN="${HOSTNAME_FQDN:-fileshare.aurorahosting.nl}"
SERVICE_URL="${SERVICE_URL:-http://localhost:8080}"
TUNNEL_NAME="${TUNNEL_NAME:-fileshare}"

echo "==> Installing cloudflared"
export DEBIAN_FRONTEND=noninteractive
if ! command -v cloudflared >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq curl gnupg ca-certificates
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared
fi
cloudflared --version

if [ -n "${TUNNEL_TOKEN:-}" ]; then
  echo "==> Installing dashboard-managed tunnel as a service"
  cloudflared service install "$TUNNEL_TOKEN"
  cat <<NEXT

Done. Now, in the Cloudflare dashboard, give this tunnel a public hostname:

  Subdomain : fileshare
  Domain    : aurorahosting.nl
  Type      : HTTP
  URL       : localhost:8080

WebSockets are enabled by default on proxied hostnames, which this app needs
for signalling.
NEXT
  exit 0
fi

echo "==> No TUNNEL_TOKEN set; using a locally-managed tunnel."
if [ ! -f /root/.cloudflared/cert.pem ]; then
  echo
  echo "A browser login is required. cloudflared will print a URL - open it on"
  echo "any machine, pick the aurorahosting.nl zone, and authorise."
  echo
  cloudflared tunnel login
fi

if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "==> Creating tunnel $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}' | head -1)"
if [ -z "$TUNNEL_ID" ]; then
  echo "!! Could not determine tunnel id" >&2
  exit 1
fi
echo "    tunnel id: $TUNNEL_ID"

echo "==> Writing /etc/cloudflared/config.yml"
mkdir -p /etc/cloudflared
install -m 0600 "/root/.cloudflared/${TUNNEL_ID}.json" "/etc/cloudflared/${TUNNEL_ID}.json"
cat > /etc/cloudflared/config.yml <<CFG
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/${TUNNEL_ID}.json

# Large uploads are irrelevant here - file bytes go peer to peer and never
# traverse the tunnel. Only signalling (a WebSocket) and static assets do.
ingress:
  - hostname: ${HOSTNAME_FQDN}
    service: ${SERVICE_URL}
    originRequest:
      connectTimeout: 30s
      noHappyEyeballs: false
  - service: http_status:404
CFG

echo "==> Pointing DNS at the tunnel"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_FQDN" || \
  echo "    (route may already exist - continuing)"

echo "==> Installing cloudflared as a service"
cloudflared service install || true
systemctl enable --now cloudflared
sleep 3
systemctl is-active --quiet cloudflared && echo "    cloudflared is running" || {
  journalctl -u cloudflared -n 30 --no-pager; exit 1; }

cat <<NEXT

Tunnel is up. Give DNS a moment, then check:

  curl -sI https://${HOSTNAME_FQDN}/healthz

NEXT
