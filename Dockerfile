# UNVERIFIED: this Dockerfile has never been built or run (the container engine was unavailable when it was written).
# It is not a supported install path. The supported way to run UndoKit today is `npx undokit serve`.
# UndoKit daemon image. No telemetry, no phone-home, no baked-in secrets.
# Build:  docker build -t undokit-sandbox:local .
# Run:    no daemon service exists in compose.yaml yet; publish the port on 127.0.0.1 only if you run it by hand.

# ---- build stage -------------------------------------------------------------------------
FROM node:22.12-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY schemas ./schemas
COPY migrations ./migrations
COPY templates ./templates
RUN npm run build && npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------------------
FROM node:22.12-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/schemas ./schemas
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/templates ./templates

# Data directory (owner-only). Mount a named volume here.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME ["/data"]

USER node
EXPOSE 8787

# Liveness only: /health does not touch the database or any provider.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/src/cli/main.js"]
# 0.0.0.0 is the in-container bind; compose publishes the port on 127.0.0.1 of the host only.
CMD ["serve", "--host", "0.0.0.0", "--port", "8787", "--data-dir", "/data"]
