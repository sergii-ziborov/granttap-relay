FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3201 \
    DATABASE_PATH=/data/relay.sqlite3

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

USER node
EXPOSE 3201
CMD ["node", "src/node/server.js"]
