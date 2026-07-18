// Production static serving for the built frontend bundle.
//
// In production the single container serves BOTH the API and the compiled
// frontend (ADR-0011): one Fastify process on 8080. This module mounts the
// Vite build output (frontend/dist) as static files with an SPA fallback so
// deep links resolve to index.html, while every /api/* route keeps taking
// precedence (they are registered first and match before the static wildcard).
//
// Local dev is unaffected: Vite serves the frontend on 5173 and proxies /api to
// this backend, and no dist directory exists, so static serving stays off. The
// gate is explicit via SERVE_STATIC; otherwise it auto-detects the dist dir.
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve frontend/dist relative to this source file (backend/src/api), so the
// path is correct both in local dev and inside the container image, wherever the
// repo is rooted. Overridable via FRONTEND_DIST for non-standard layouts.
function resolveDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // backend/src/api
  return process.env.FRONTEND_DIST ?? join(here, '..', '..', '..', 'frontend', 'dist');
}

export async function registerStaticServing(app: FastifyInstance): Promise<void> {
  const distDir = resolveDistDir();

  // SERVE_STATIC (true/false) forces the decision; without it, serve only when a
  // built bundle is actually present. This keeps `npm run dev` in proxy mode.
  const forced = process.env.SERVE_STATIC;
  const serveStatic =
    forced !== undefined ? forced.toLowerCase() === 'true' || forced === '1' : existsSync(distDir);

  if (!serveStatic) {
    app.log.info('static frontend serving disabled (no dist bundle); dev proxy mode');
    return;
  }

  if (!existsSync(distDir)) {
    app.log.warn({ distDir }, 'SERVE_STATIC set but dist dir missing; skipping static serving');
    return;
  }

  // wildcard:false lets unmatched paths fall through to the SPA notFoundHandler
  // rather than 404-ing at the static layer.
  await app.register(fastifyStatic, { root: distDir, wildcard: false });
  app.log.info({ distDir }, 'serving built frontend bundle');

  // SPA fallback: any non-API GET that did not match a static file returns the
  // app shell so client-side routes resolve. API and non-GET requests keep a
  // real 404.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', path: req.url });
  });
}
