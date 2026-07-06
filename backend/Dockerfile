# Order Health backend image: Fastify read API + node-cron aggregator.
#
# The backend runs its TypeScript directly via tsx (the start script), and the
# shared workspace is consumed as source, so there is no separate compile step.
# Build context is the REPO ROOT so the npm workspaces install can see every
# workspace manifest and the lockfile.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching. All workspace manifests
# plus the lockfile are needed for a deterministic install.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci

# Copy the sources the backend actually needs (shared is imported from source).
COPY shared ./shared
COPY backend ./backend

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# start = "tsx src/index.ts": boots the Fastify read API and the aggregator.
CMD ["npm", "run", "start", "--workspace", "backend"]
