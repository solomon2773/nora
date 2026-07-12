FROM node:24-alpine
WORKDIR /app
ENV NODE_PATH=/app/node_modules

RUN apk add --no-cache postgresql-client

COPY workers/backup/package.json workers/backup/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY tsconfig.base.json /tsconfig.base.json
COPY workers/backup/ ./
COPY backend-api /backend-api
COPY agent-runtime /agent-runtime
COPY workers/provisioner/backends /backend-api/backends
RUN cd /backend-api && (npm ci --omit=dev || npm install --omit=dev)

CMD ["npm", "start"]
