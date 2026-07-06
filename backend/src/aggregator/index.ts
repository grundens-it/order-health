// Health aggregator scaffold + scheduled-writer skeleton.
//
// On a cadence it reads the sources (stubbed), computes the two-layer model,
// stamps a single as_of per run, and writes the snapshot tables. The order
// layer and inventory layer run on independent, conservative cadences
// (ADR-0002): order layer every 2 to 5 minutes, inventory layer aligned to the
// ~2h IABC cycle. Cadences come from config.
import cron from 'node-cron';
import { config } from '../config';
import { createMiddlewareClient } from '../sources/middlewareClient';
import { createNavClient } from '../sources/navClient';
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
  return { middleware: createMiddlewareClient(), nav: createNavClient() };
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

  return [orderTask, inventoryTask];
}
