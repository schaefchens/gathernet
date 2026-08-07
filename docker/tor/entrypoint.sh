#!/bin/sh
# Generate a torrc, ensure the hidden-service dir has the strict perms Tor demands,
# print the .onion once it's published, then run tor as the unprivileged `tor` user.
#
# HS_TARGET     = where the hidden service forwards :80 to.
#   dev:  host.docker.internal:5173  (the host-run `pnpm dev` server)
#   prod: web:8080                   (the web container on the compose network)
# HS_TLS_TARGET = where it forwards :443 to — a TLS terminator holding the cert this
#   script mints below. Empty → no :443 (plain-HTTP onion, the original behaviour).
set -e

HS_DIR=/var/lib/tor/gathernet
DATA_DIR=/var/lib/tor/data
CERT_DIR=/certs
HS_TARGET="${HS_TARGET:-host.docker.internal:5173}"
HS_TLS_TARGET="${HS_TLS_TARGET:-}"

mkdir -p "$HS_DIR" "$DATA_DIR"

# Adopt a seeded key if one is mounted at /seed (e.g. a vanity address generated offline):
# copy the HS keypair into the service dir so Tor uses THAT identity instead of generating
# a random one. Overwrites on every start, so the seed is the source of truth. No seed →
# Tor keeps the existing key or generates a fresh one (original behaviour).
if [ -f /seed/hs_ed25519_secret_key ]; then
  cp /seed/hs_ed25519_secret_key /seed/hs_ed25519_public_key "$HS_DIR"/
  [ -f /seed/hostname ] && cp /seed/hostname "$HS_DIR"/
  echo "adopted seeded onion key from /seed"
fi

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

# :443 as well as :80, when a terminator is configured.
#
# Why both. WebKit — which is every iOS browser, Brave included — does not implement
# the ".onion is potentially trustworthy" carve-off that Chromium and Tor Browser do,
# so over plain HTTP an iPhone gets isSecureContext=false, no crypto.subtle, and the
# app cannot even enroll a device. HTTPS makes it secure on any engine. But a
# self-signed cert is a *certificate error*, and browsers refuse to register service
# workers on such an origin — which would take push away from the Chromium users who
# work fine today. So :80 stays for them and :443 is added for everyone else, until a
# CA-issued cert (see docs/onion.md) makes :443 good enough for all of them.
if [ -n "$HS_TLS_TARGET" ]; then
  echo "HiddenServicePort 443 $HS_TLS_TARGET" >> /tmp/torrc
fi

# Announce the address as soon as Tor writes the hostname file (immediate on start;
# reachability over the network follows once bootstrap hits 100%).
(
  i=0
  while [ ! -f "$HS_DIR/hostname" ] && [ "$i" -lt 60 ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ -f "$HS_DIR/hostname" ]; then
    ONION="$(cat "$HS_DIR/hostname")"
    # Mint the TLS cert here, because this is the only container that knows the address
    # before it exists. Kept in the same volume as the onion key so it is as stable as
    # the address is: iOS pins an accepted exception to the certificate, so a cert that
    # rotated (Caddy's internal CA reissues twice a day) would re-prompt every time.
    # A real CA cert dropped into this volume is used instead of generating one.
    if [ -n "$HS_TLS_TARGET" ] && [ -d "$CERT_DIR" ]; then
      if [ ! -f "$CERT_DIR/onion.crt" ] || [ ! -f "$CERT_DIR/onion.key" ]; then
        openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
          -subj "/CN=$ONION" -addext "subjectAltName=DNS:$ONION" \
          -keyout "$CERT_DIR/onion.key" -out "$CERT_DIR/onion.crt" >/dev/null 2>&1
        chmod 644 "$CERT_DIR/onion.crt"
        chmod 640 "$CERT_DIR/onion.key"
        echo "minted self-signed TLS cert for $ONION (10y)"
      fi
      # The terminator runs as a different user; it only ever needs to read these.
      chmod o+r "$CERT_DIR/onion.key" 2>/dev/null || true
    fi
    printf '\n============================================================\n'
    printf '  Gathernet onion address (share this to test over Tor):\n'
    printf '    http://%s\n' "$ONION"
    if [ -n "$HS_TLS_TARGET" ]; then
      printf '    https://%s   (needed by iOS — self-signed, expect a warning)\n' "$ONION"
    fi
    printf '============================================================\n\n'
  fi
) &

exec su-exec tor tor -f /tmp/torrc
