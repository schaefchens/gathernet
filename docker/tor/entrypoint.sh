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
    # Mint the TLS material here, because this is the only container that knows the
    # address before it exists.
    #
    # A private CA and a leaf under it, not one self-signed cert, because the point is
    # to make the warning go away and only a trust anchor can do that. Install the CA
    # on the device once (docs/onion.md) and every leaf it signs is trusted — no
    # interstitial, and service workers register, which a cert error would forbid.
    #
    # Apple is strict about the leaf and a plain `req -x509` satisfies none of it: a TLS
    # server certificate needs extendedKeyUsage=serverAuth, must not claim CA:TRUE, and
    # must not outlive 398 days. Break any of those and iOS refuses the connection
    # outright rather than offering to continue.
    #
    # ONION_TLS_MANAGED=0 hands the directory over entirely — drop a CA-issued
    # onion.crt/onion.key in and nothing here touches them.
    if [ -n "$HS_TLS_TARGET" ] && [ -d "$CERT_DIR" ] && [ "${ONION_TLS_MANAGED:-1}" = "1" ]; then
      CA_CRT="$CERT_DIR/onion-ca.crt"
      CA_KEY="$CERT_DIR/onion-ca.key"
      fresh_ca=0

      if [ ! -f "$CA_CRT" ] || [ ! -f "$CA_KEY" ]; then
        # The anchor is long-lived on purpose: it is the thing a person installs by hand,
        # and the 398-day cap is a rule about server certificates, not roots.
        # Name-constrained to this one address. Installing a root is handing a device a
        # key that can vouch for anything, and this key sits on a server — so bound it
        # to the single host it exists for. If it ever leaks it can still only
        # impersonate this onion, not a bank.
        openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -sha256 \
          -subj "/CN=Gathernet onion CA/O=Gathernet" \
          -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
          -addext "keyUsage=critical,keyCertSign,cRLSign" \
          -addext "nameConstraints=critical,permitted;DNS:$ONION" \
          -keyout "$CA_KEY" -out "$CA_CRT" >/dev/null 2>&1
        chmod 644 "$CA_CRT"
        chmod 640 "$CA_KEY"
        fresh_ca=1
        echo "minted onion CA (10y) — install $CA_CRT on iOS, see docs/onion.md"
      fi

      # Reissue when the leaf is missing, within 30 days of expiry, or orphaned by a new CA.
      if [ "$fresh_ca" = "1" ] || [ ! -f "$CERT_DIR/onion.crt" ] || [ ! -f "$CERT_DIR/onion.key" ] \
        || ! openssl x509 -in "$CERT_DIR/onion.crt" -noout -checkend 2592000 >/dev/null 2>&1; then
        cat > /tmp/leaf.ext <<EXT
subjectAltName=DNS:$ONION
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EXT
        openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$ONION" \
          -keyout /tmp/leaf.key -out /tmp/leaf.csr >/dev/null 2>&1
        openssl x509 -req -in /tmp/leaf.csr -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
          -days 397 -sha256 -extfile /tmp/leaf.ext -out /tmp/leaf.crt >/dev/null 2>&1
        mv /tmp/leaf.key "$CERT_DIR/onion.key"
        # Leaf first, then the anchor: Caddy serves the file as the chain, so a client
        # that already trusts the CA never has to fetch anything.
        cat /tmp/leaf.crt "$CA_CRT" > "$CERT_DIR/onion.crt"
        rm -f /tmp/leaf.csr /tmp/leaf.crt /tmp/leaf.ext
        chmod 644 "$CERT_DIR/onion.crt"
        chmod 640 "$CERT_DIR/onion.key"
        # 397 rather than Apple's 398-day ceiling, so a day of rounding anywhere in the
        # chain of validators can't put it over.
        echo "issued TLS leaf for $ONION (397d, serverAuth)"
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
