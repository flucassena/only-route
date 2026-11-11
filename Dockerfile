FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openfortivpn socat ca-certificates iproute2 \
 && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
