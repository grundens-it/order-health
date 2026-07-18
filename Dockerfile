# Order Health single-container image (ADR-0011).
#
# One Linux container serves BOTH the Fastify read API and the built frontend on
# port 8080. Stage 1 installs the npm workspaces (dev deps included) and runs the
# Vite build; stage 2 is a lean runtime that carries the backend source, the
# shared workspace (imported from source), the hoisted node_modules (tsx runs the
# backend directly), and the compiled frontend/dist the backend serves statically.
#
# Build context is the REPO ROOT so the workspaces install sees every manifest
# and the lockfile. This is the image .github/workflows/deploy.yml builds and
# pushes as grundens.azurecr.io/order-health:<sha>.

# --- Stage 1: build the frontend bundle -------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Manifests + lockfile first for deterministic, cacheable installs.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
# Full install (dev deps needed for tsc + vite). NODE_ENV is intentionally unset
# here so devDependencies are installed.
RUN npm ci

# Sources needed to typecheck and build the frontend (shared is imported from
# source; backend is copied so the runtime stage can lift it from this layer).
COPY shared ./shared
COPY frontend ./frontend
COPY backend ./backend

# Emits frontend/dist (tsc --noEmit && vite build).
RUN npm run build --workspace frontend

# --- Stage 2: runtime -------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

# Hoisted node_modules (includes tsx) plus the sources the backend runs from and
# the built bundle it serves. No build tooling is invoked at runtime.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/backend ./backend
COPY --from=build /app/frontend/package.json ./frontend/package.json
COPY --from=build /app/frontend/dist ./frontend/dist

EXPOSE 8080

# start = "tsx src/index.ts": boots the Fastify read API + aggregator and, because
# frontend/dist is present, serves the SPA on the same port (ADR-0011).
CMD ["npm", "run", "start", "--workspace", "backend"]
