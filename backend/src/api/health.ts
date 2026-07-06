// Read-only health API. Every response is wrapped in the as_of envelope so the
// snapshot materialization time is always present (ADR-0002). These handlers
// read ONLY the snapshot repository; there are no live source calls in the
// request path.
import type { FastifyInstance } from 'fastify';
import type { ChannelFilter, PipelinesResponse, OrdersResponse } from '@order-health/shared';
import { envelope } from '@order-health/shared';
import { latestOrders, latestPipelines } from '../repo/snapshotRepo';

function parseChannel(raw: unknown): ChannelFilter {
  if (raw === 'dtc' || raw === 'wholesale' || raw === 'all') return raw;
  return 'all';
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // Pipeline-health strip data.
  app.get('/api/health/pipelines', async (): Promise<PipelinesResponse> => {
    const snap = await latestPipelines();
    return envelope(snap.asOf, snap.rows);
  });

  // Order-health table data, filtered by channel (dtc | wholesale | all).
  app.get('/api/health/orders', async (req): Promise<OrdersResponse> => {
    const channel = parseChannel((req.query as { channel?: unknown }).channel);
    const snap = await latestOrders(channel);
    return envelope(snap.asOf, snap.rows);
  });

  // Liveness of THIS service (not a source verdict). Cheap, no DB required.
  app.get('/api/health/ping', async () => ({ ok: true, as_of: new Date().toISOString() }));
}
