FROM node:24-alpine

LABEL org.opencontainers.image.title="Nora MCP Server" \
      org.opencontainers.image.description="Operate a self-hosted Nora agent fleet from MCP clients." \
      org.opencontainers.image.source="https://github.com/solomon2773/nora" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force

COPY --chown=node:node src ./src

USER node
ENTRYPOINT ["node", "src/index.js"]
