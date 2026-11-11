#!/bin/sh
# Connects to a FortiGate SSL VPN inside this container and relays a few sites
# through it. Nothing outside the container is routed through the VPN.
set -e

# Keep the route back to Docker (where the relayed connections come from) even
# if the VPN pushes routes that overlap the Docker network.
GW=$(ip route | awk '/^default/ {print $3; exit}')
[ -n "$GW" ] && ip route add "$GW/32" dev eth0 2>/dev/null || true

# Raw TCP relays, one per site: "<container port>=<host>:<port> ...".
# Windows' hosts file points each site at a 127.0.0.x address that Docker maps
# to the container port. TLS stays end to end between the program and the site.
for f in $FORWARDS; do
  socat "TCP-LISTEN:${f%%=*},fork,reuseaddr" "TCP:${f#*=}" >/dev/null 2>&1 &
done

set -- "$VPN_HOST:$VPN_PORT" -u "$VPN_USER" \
  --set-dns=1 --pppd-use-peerdns=1 --pppd-accept-remote=1
[ -n "$TRUSTED_CERT" ] && set -- "$@" --trusted-cert "$TRUSTED_CERT"

if [ "$DETACHED" = 1 ]; then
  # Background mode: the password and the code arrive through a pipe
  # (written by onlyroute.ps1 or the app with docker exec), and the output goes to a file
  # so the script can see the prompts even before they end with a newline.
  mkfifo /run/vpn-input
  exec 3<>/run/vpn-input
  : > /run/vpn.log
  tail -f /run/vpn.log &
  exec openfortivpn "$@" <&3 >/run/vpn.log 2>&1
fi

exec openfortivpn "$@"
