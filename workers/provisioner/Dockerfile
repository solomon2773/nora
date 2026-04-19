FROM node:24-alpine
WORKDIR /app
COPY workers/provisioner/package.json workers/provisioner/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY tsconfig.base.json /tsconfig.base.json
COPY workers/provisioner/ ./
COPY agent-runtime /agent-runtime
CMD ["npm", "start"]
