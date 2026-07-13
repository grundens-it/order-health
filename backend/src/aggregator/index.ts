// Health aggregator scaffold + scheduled-writer skeleton.
//
// On a cadence it reads the sources (stubbed), computes the two-layer model,
// stamps a single as_of per run, and writes the snapshot tables. Both cadences
// are EVALUATION intervals (how often we re-check and write a snapshot so a
// stall or a stuck order is caught promptly), NOT data intervals: the order
// layer covers orders (default every 3 min) and the inventory layer covers all
// six pipes (default every 5 min). The inventory-sync pipe still bands its
// freshness verdict in ~2h IABC cycles (INVENTORY_CYCLE_SECONDS), so a fast
// evaluation cadence catches a stalled watermark within minutes, not hours.
// Cadences come from config.
import cron from 'node-cron';
import { config } from '../config';
import { createMiddlewareClient } from '../sources/middlewareClient';
import { createNavClient } from '../sources/navClient';
import { createShopifyClient } from '../sources/shopifyClient';
import {
  computeOrders,
  computePipelines,
  recordOrderTransitions,
  recordPipelineTransitions,
  writeOrderSnapshot,
  writePipelineSnapshot,
  type Sources,
} from './writers';

function sources(): Sources {
  return {
    middleware: createMiddlewareClient(),
    nav: createNavClient(),
    shopify: createShopifyClient(),
  };
}

// One order-layer run. Exported so it can be invoked directly (tests / manual).
// Transitions are recorded from the PREVIOUS snapshot BEFORE the new one is
// written (health_transition wiring, design.md 8). No remediation is invoked.
export async function runOrderLayer(): Promise<void> {
  const asOf = new Date().toISOString();
  const orders = await computeOrders(sources());
  await recordOrderTransitions(asOf, orders);
  await writeOrderSnapshot(asOf, orders);
}

// One inventory/pipeline-layer run. Same order: record transitions against the
// previous snapshot, then write the new one.
export async function runInventoryLayer(): Promise<void> {
  const asOf = new Date().toISOString();
  const pipes = await computePipelines(sources());
  await recordPipelineTransitions(asOf, pipes);
  await writePipelineSnapshot(asOf, pipes);
}

// Wire the schedulers. Returns the scheduled tasks so the server can stop them
// on shutdown. Does nothing (beyond a log) when AGGREGATOR_ENABLED is false,
// which is the default posture until DevOps provisions the read-only sources.
export function startAggregator(): cron.ScheduledTask[] {
  if (!config.aggregator.enabled) {
    // eslint-disable-next-line no-console
    console.info('[aggregator] disabled (AGGREGATOR_ENABLED=false); read API serves last snapshot / stub');
    return [];
  }

  // eslint-disable-next-line no-console
  console.info(
    `[aggregator] scheduling order layer "${config.aggregator.orderLayerCron}" ` +
      `and inventory layer "${config.aggregator.inventoryLayerCron}"`,
  );

  const orderTask = cron.schedule(config.aggregator.orderLayerCron, () => {
    void runOrderLayer().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[aggregator] order layer run failed', err);
    });
  });

  const inventoryTask = cron.schedule(config.aggregator.inventoryLayerCron, () => {
    void runInventoryLayer().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[aggregator] inventory layer run failed', err);
    });
  });

  // Run each layer once immediately on startup so a freshly booted service has a
  // snapshot right away, instead of an empty dashboard until the first cron tick.
  // Without this the inventory layer's ~2h cadence would leave the pipeline strip
  // empty for hours after boot. In stub mode the initial snapshot grades every
  // pipe "unknown", which is the honest state until the sources are provisioned.
  // eslint-disable-next-line no-console
  console.info('[aggregator] running initial snapshot on startup');
  void runOrderLayer().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[aggregator] initial order layer run failed', err);
  });
  void runInventoryLayer().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[aggregator] initial inventory layer run failed', err);
  });

  return [orderTask, inventoryTask];
}
