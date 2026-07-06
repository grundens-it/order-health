import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies /api to the backend so the frontend fetches relative URLs.
// The proxy target is overridable via API_PROXY_TARGET (defaults to localhost for
// plain `npm run dev`; the Docker stack points it at the backend service). host:
// true binds all interfaces so the container is reachable from the host.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': apiProxyTarget,
    },
  },
});
