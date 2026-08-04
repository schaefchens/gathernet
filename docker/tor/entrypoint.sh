#!/bin/sh
# Generate a torrc, ensure the hidden-service dir has the strict perms Tor demands,
# print the .onion once it's published, then run tor as the unprivileged `tor` user.
#
# HS_TARGET = where the hidden service forwards :80 to.
#   dev:  host.docker.internal:5173  (the host-run `pnpm dev` server)
#   prod: web:8080                   (the web container on the compose network)
set -e

HS_DIR=/var/lib/tor/gathernet
DATA_DIR=/var/lib/tor/data
HS_TARGET="${HS_TARGET:-host.docker.internal:5173}"

mkdir -p "$HS_DIR" "$DATA_DIR"
chown -R tor:tor /var/lib/tor
# Tor refuses to start a hidden service unless the dir is 700 and owned by its user.
chmod 700 "$HS_DIR" "$DATA_DIR"

cat > /tmp/torrc <<EOF
# We only host a hidden service; no SOCKS proxy is needed.
SocksPort 0
DataDirectory $DATA_DIR
HiddenServiceDir $HS_DIR
HiddenServiceVersion 3
HiddenServicePort 80 $HS_TARGET
Log notice stdout
EOF

# Announce the address as soon as Tor writes the hostname file (immediate on start;
# reachability over the network follows once bootstrap hits 100%).
(
  i=0
  while [ ! -f "$HS_DIR/hostname" ] && [ "$i" -lt 60 ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ -f "$HS_DIR/hostname" ]; then
    printf '\n============================================================\n'
    printf '  Gathernet onion address (share this to test over Tor):\n'
    printf '    http://%s\n' "$(cat "$HS_DIR/hostname")"
    printf '============================================================\n\n'
  fi
) &

exec su-exec tor tor -f /tmp/torrc
