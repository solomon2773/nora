FROM node:24-alpine
WORKDIR /app
ENV NODE_PATH=/app/node_modules
ARG NPM_INSTALL_TIMEOUT_SECONDS=900

COPY workers/provisioner/package.json workers/provisioner/package-lock.json* ./
RUN set -eu; \
  timeout -k 30 "$NPM_INSTALL_TIMEOUT_SECONDS" npm ci --omit=dev \
  || { \
    status=$?; \
    case "$status" in 124|137|143) exit "$status" ;; esac; \
    timeout -k 30 "$NPM_INSTALL_TIMEOUT_SECONDS" npm install --omit=dev; \
  }

# Cache backend runtime dependencies independently from the full source tree.
# The later COPY merges into /backend-api and preserves this node_modules tree.
COPY backend-api/package.json backend-api/package-lock.json* /backend-api/
RUN set -eu; \
  cd /backend-api; \
  timeout -k 30 "$NPM_INSTALL_TIMEOUT_SECONDS" npm ci --omit=dev \
  || { \
    status=$?; \
    case "$status" in 124|137|143) exit "$status" ;; esac; \
    timeout -k 30 "$NPM_INSTALL_TIMEOUT_SECONDS" npm install --omit=dev; \
  }

COPY tsconfig.base.json /tsconfig.base.json
COPY workers/provisioner/ ./
COPY agent-runtime /agent-runtime
COPY backend-api /backend-api
CMD ["npm", "start"]
