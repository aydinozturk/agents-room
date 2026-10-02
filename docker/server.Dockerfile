# agents-room sunucu (masa) imajı: MCP sunucusu + görev panosu + izleme paneli.
# Tek Node süreci; veritabanı (SQLite), admin token'ı ve kayıt sırrı /data biriminde kalır.
#
#   docker compose -f docker/server.compose.yaml up -d --build   (ayrıntılar: docs/docker.md)
#   docker exec agents-room-server agents-room token             # panel girişi
#   docker exec agents-room-server agents-room secret            # diğer makineler için kayıt sırrı
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim

WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/src ./src
COPY server/public ./public
COPY docker/server-cli.sh /usr/local/bin/agents-room

# Kalıcı birim imajdaki dizinin sahipliğini devralır: /data sunucu kullanıcısına ait olmalı.
RUN mkdir -p /data && chown node:node /data && chmod 755 /usr/local/bin/agents-room

ENV NODE_ENV=production \
    AGENTS_ROOM_DB=/data/agents-room.db \
    AGENTS_ROOM_HOST=0.0.0.0 \
    AGENTS_ROOM_PORT=7700 \
    AGENTS_ROOM_IN_DOCKER=1

USER node
VOLUME /data
EXPOSE 7700

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AGENTS_ROOM_PORT||7700)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/index.ts"]
