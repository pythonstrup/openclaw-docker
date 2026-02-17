#!/bin/sh
set -eu

# Restrict container egress via host DOCKER-USER chain.
# Requires: root, iptables, docker.
#
# Default policy in this script:
# - allow ESTABLISHED/RELATED
# - allow DNS (53/tcp,53/udp)
# - allow HTTPS (443/tcp)
# - drop everything else
#
# Usage:
#   sudo CONTAINER_NAME=openclaw-secure ./scripts/security/egress-allowlist.sh

CONTAINER_NAME="${CONTAINER_NAME:-openclaw-secure}"
CHAIN="${CHAIN:-OPENCLAW_EGRESS}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need_cmd docker
need_cmd iptables

CONTAINER_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [ -z "$CONTAINER_IP" ]; then
  echo "failed to resolve container IP for $CONTAINER_NAME" >&2
  exit 1
fi

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"

iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A "$CHAIN" -p udp --dport 53 -j ACCEPT
iptables -A "$CHAIN" -p tcp --dport 53 -j ACCEPT
iptables -A "$CHAIN" -p tcp --dport 443 -j ACCEPT
iptables -A "$CHAIN" -j DROP

while iptables -C DOCKER-USER -s "$CONTAINER_IP"/32 -j "$CHAIN" 2>/dev/null; do
  iptables -D DOCKER-USER -s "$CONTAINER_IP"/32 -j "$CHAIN"
done
iptables -I DOCKER-USER 1 -s "$CONTAINER_IP"/32 -j "$CHAIN"

echo "egress allowlist applied for $CONTAINER_NAME ($CONTAINER_IP)"
