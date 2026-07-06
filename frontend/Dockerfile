# Order Health frontend image: the Vite dev server for the two-layer dashboard.
#
# Runs the Vite dev server bound to all interfaces so the host can reach it, and
# proxies /api to the backend service (target from API_PROXY_TARGET, see
# vite.config.ts). Build context is the REPO ROOT for the workspaces install.
FROM node:22-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci

# The frontend imports @order-health/shared from source, so copy both workspaces.
COPY shared ./shared
COPY frontend ./frontend

EXPOSE 5173

# Vite dev server on 0.0.0.0:5173 so it is reachable from outside the container.
CMD ["npm", "run", "dev", "--workspace", "frontend", "--", "--host", "0.0.0.0"]
