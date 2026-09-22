ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG DEBIAN_MIRROR=deb.debian.org

RUN sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg fuse3 util-linux \
  && rm -rf /var/lib/apt/lists/*

# Official tigrisfs 1.2.2 linux/amd64 release asset. The API endpoint avoids
# github.com download connectivity failures; verify the release digest as well.
RUN curl --http1.1 -fsSL --connect-timeout 20 --max-time 180 --retry 3 \
    -H 'Accept: application/octet-stream' \
    https://api.github.com/repos/tigrisdata/tigrisfs/releases/assets/531279464 -o /tmp/tigrisfs.tar.gz \
  && echo 'fd0c19c5c1d19eebd466cd4b6ce8f38286bedad6d792e6202cc3c916ce5e4281  /tmp/tigrisfs.tar.gz' | sha256sum -c - \
  && tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin tigrisfs \
  && chmod +x /usr/local/bin/tigrisfs \
  && rm /tmp/tigrisfs.tar.gz

WORKDIR /app
COPY server.mjs startup.sh ./
RUN chmod +x /app/startup.sh

ENV PORT=8080 R2_MOUNT_PATH=/mnt/r2
EXPOSE 8080
CMD ["/app/startup.sh"]
