#!/usr/bin/env bash
# Run this ON THE PROXMOX HOST, not inside a container.
#
# Creates an unprivileged Debian 12 container for Aurora FileShare.
# The app only relays signalling, so it stays small - file bytes go peer to peer
# and never pass through here.
set -euo pipefail

CTID="${CTID:-112}"
HOSTNAME="${HOSTNAME_:-fileshare}"
STORAGE="${STORAGE:-vm-storage}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
TEMPLATE="${TEMPLATE:-debian-12-standard_12.12-1_amd64.tar.zst}"
BRIDGE="${BRIDGE:-vmbr0}"
# Static keeps the tunnel target predictable; set IP=dhcp to use DHCP instead.
IP="${IP:-192.168.1.50/24}"
GATEWAY="${GATEWAY:-192.168.1.1}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-1024}"
DISK="${DISK:-8}"

if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
  echo "==> Downloading template $TEMPLATE"
  pveam update
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

echo "==> Creating CT $CTID ($HOSTNAME)"
NET="name=eth0,bridge=$BRIDGE"
if [ "$IP" = "dhcp" ]; then
  NET="$NET,ip=dhcp"
else
  NET="$NET,ip=$IP,gw=$GATEWAY"
fi

pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" \
  --memory "$MEMORY" \
  --swap 512 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "$NET" \
  --features nesting=1 \
  --unprivileged 1 \
  --onboot 1 \
  --description "Aurora FileShare - P2P file transfer signalling + static site"

pct start "$CTID"
echo "==> Waiting for network"
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> Container $CTID is up."
echo
echo "Next:"
echo "  pct push $CTID ./bootstrap.sh /root/bootstrap.sh"
echo "  pct exec $CTID -- bash /root/bootstrap.sh"
