# syntax=docker/dockerfile:1

# ── build: compile TypeScript, then drop dev dependencies ──────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HEALTH_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node assets ./assets
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The app handles SIGTERM itself (graceful shutdown).
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
