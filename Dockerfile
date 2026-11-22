FROM node:20-alpine
# postgresql-client : pg_dump/pg_restore pour `npm run backup` ; tini : gestion propre des signaux
RUN apk add --no-cache postgresql-client tini
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend ./backend
COPY frontend ./frontend
RUN mkdir -p /app/backups && chown node:node /app/backups
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/src/server.js"]
