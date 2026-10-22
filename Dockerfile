FROM node:24.22.1-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.22.1-bookworm-slim

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

RUN mkdir -p /app/data/images /app/images /app/backups \
  && chown -R node:node /app/data /app/images /app/backups

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    DB_PATH=/app/data/gallery.sqlite \
    STORAGE_ROOT=/app/data/images \
    BACKUP_DIR=/app/backups

USER node
EXPOSE 3000

CMD ["node", "server/server.js"]
