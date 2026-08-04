# Tor v3 hidden service that fronts the Gathernet app over an .onion address.
# Tor makes only OUTBOUND connections to the Tor network — no inbound ports are
# published, so this container adds no externally reachable surface. The onion
# private key lives in the mounted volume (/var/lib/tor), which is what makes the
# address stable + shareable across restarts. Keep that volume secret: whoever holds
# the key controls the address.
FROM alpine:3.20

RUN apk add --no-cache tor su-exec

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
