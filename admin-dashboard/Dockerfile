FROM node:24-alpine AS deps
WORKDIR /app
COPY admin-dashboard/package.json admin-dashboard/package-lock.json* ./
RUN npm ci || npm install

FROM node:24-alpine AS builder
WORKDIR /app
COPY tsconfig.base.json /tsconfig.base.json
COPY --from=deps /app/node_modules ./node_modules
COPY admin-dashboard/ ./
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=builder /app/.next/standalone/app/ ./
COPY --from=builder /app/.next/static ./.next/static
RUN --mount=from=builder,source=/app,target=/build \
    cp -r /build/public ./public 2>/dev/null || true
EXPOSE 3000
CMD ["node", "server.js"]
