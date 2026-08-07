#!/bin/sh
# Decide whether this deployment serves the onion over TLS, then start Caddy.
#
# The onion's cert is minted by the `tor` container (the only one that knows the address
# before it exists) and arrives through the shared `onioncerts` volume. Caddy refuses to
# start when a `tls` directive names a file that isn't there, so the :443 site is written
# only once the cert is on disk — a clearnet-only deployment has no onion, no cert, and
# gets no TLS site rather than a container that won't boot.
set -e

CONF_D=/etc/caddy/conf.d
CERT=/certs/onion.crt
KEY=/certs/onion.key

mkdir -p "$CONF_D"

# Only wait when an onion is configured. Compose starts `tor` as soon as this container
# is running (depends_on waits for started, not ready), so the cert lands during this
# loop on a cold boot. Without ONION_HOST there is nothing to wait for.
if [ -n "$ONION_HOST" ]; then
  i=0
  while [ ! -f "$CERT" ] && [ "$i" -lt 60 ]; do
    sleep 1
    i=$((i + 1))
  done
fi

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  # WebKit — every iOS browser, Brave included — does not treat a plain-HTTP .onion as a
  # secure context, so without this an iPhone has no crypto.subtle and cannot enroll a
  # device. :8080 stays as it is, because a certificate error would cost the Chromium
  # clients that work today their service worker. See docs/onion.md.
  cat > "$CONF_D/onion-tls.caddy" <<EOF
:8443 {
	tls $CERT $KEY
	import app
}
EOF
  echo "onion TLS enabled (:8443)"
else
  : > "$CONF_D/onion-tls.caddy"
  [ -n "$ONION_HOST" ] && echo "warning: ONION_HOST set but $CERT never appeared — serving plain :8080 only"
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
