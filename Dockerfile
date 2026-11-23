FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/eci.db \
    PORT=3000

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./

# La base de datos SQLite vive en /data (volumen).
RUN mkdir -p /data/backups && chown -R node:node /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/index.js"]
