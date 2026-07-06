// Order Health backend entry point.
//
// Boots the Fastify read API (serves off the snapshot) and, unless disabled,
// starts the scheduled health aggregator. Read-only everywhere: the request
// path never calls a live source, and the aggregator only reads sources.
import Fastify from 'fastify';
import { config } from './config';
import { registerHealthRoutes } from './api/health';
import { startAggregator } from './aggregator';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  // Permissive CORS for the Vite dev frontend. Tighten per environment later.
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'content-type');
  });

  await registerHealthRoutes(app);

  const tasks = startAggregator();

  const close = async (): Promise<void> => {
    for (const t of tasks) t.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  await app.listen({ host: config.server.host, port: config.server.port });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal: failed to start backend', err);
  process.exit(1);
});
