# ==============================================================================
# Stage 1: Build & Bundle
# ==============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root and workspace package definitions for efficient caching
COPY package.json package-lock.json tsconfig.base.json biome.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Install full dependencies (including devDependencies)
RUN npm ci --legacy-peer-deps

# Copy sources
COPY shared/ ./shared/
COPY client/ ./client/
COPY server/ ./server/

ARG GIT_SHA=v1.0.0
ENV GIT_SHA=${GIT_SHA}

# Compile client with Vite and server with esbuild
RUN npm run build

# ==============================================================================
# Stage 2: Minimal Production Runtime (< 200 MB, non-root)
# ==============================================================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

ARG GIT_SHA=v1.0.0
ENV GIT_SHA=${GIT_SHA}

# Copy package descriptors for production install
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Install only production dependencies
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

# Copy compiled bundles from builder
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/shared/src ./shared/src

# Create logs directory and ensure node user has ownership
RUN mkdir -p /app/logs && chown -R node:node /app

# Run as non-root user for security
USER node

EXPOSE 3000

# Native container liveness healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Exec-form CMD so signals (SIGTERM, SIGINT) pass directly to Node
CMD ["node", "server/dist/index.js"]

