ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG TIGRISFS_VERSION=1.2.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg fuse3 util-linux \
  && curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/v${TIGRISFS_VERSION}/tigrisfs_${TIGRISFS_VERSION}_linux_amd64.tar.gz" -o /tmp/tigrisfs.tar.gz \
  && tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin tigrisfs \
  && chmod +x /usr/local/bin/tigrisfs \
  && rm -rf /var/lib/apt/lists/* /tmp/tigrisfs.tar.gz

WORKDIR /app
COPY server.mjs startup.sh ./
RUN chmod +x /app/startup.sh

ENV PORT=8080 R2_MOUNT_PATH=/mnt/r2
EXPOSE 8080
CMD ["/app/startup.sh"]
