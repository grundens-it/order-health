// TEST SUPPORT (Unit 8): a seeded, read-only whole-board Sources builder.
//
// This exists so the integration tests can drive the REAL layer runners
// (computePipelines / computeOrders, and from them computeRollup + the transition
// diff) against a SEEDED snapshot representing an entire board, with NO live NAV
// and NO middleware call. Every method here returns in-memory seeded data; nothing
// opens a socket, and nothing here can write upstream (design.md section 0 / 7:
// sources stay read-only). It is not a `.test.ts` file, so the runner never
// executes it directly; the test files import makeSeededSources() from it.
import type { InventoryWalk, MissedShipment } from '@order-health/shared';
import type {
  AllocatorStatus,
  BackSyncStatus,
  InventorySyncStatus,
  JobQueueHealthStatus,
  MiddlewareClient,
  PriceSyncStatus,
  ShopifyWebhookStatus,
} from '../sources/middlewareClient';
import type {
  NavClient,
  NavJobQueueState,
  NavOrderLifecycleRow,
  NavShipmentHeader,
  NavWatermarkState,
} from '../sources/navClient';
import type { Sources } from './writers';

// ISO timestamp `seconds` in the past, relative to a fixed now so a whole board
// shares one clock. Seconds granularity swamps the sub-ms drift vs the Date.now()
// the pure computes read internally, and every seeded band has minutes of margin.
export function agoIso(seconds: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - seconds * 1000).toISOString();
}

// One IABC cycle is 7200s (config default). "> 2 cycles" is the freshness-RED
// boundary; these named ages keep the staleness intent legible in the tests.
export const ONE_CYCLE_S = 7200;

// Per-pipe seed overrides. Anything omitted defaults to a healthy (green) value,
// so a test only spells out the pipe(s) it is exercising.
export interface BoardSeed {
  now?: number;
  inventory?: {
    watermark?: Partial<NavWatermarkState>;
    walks?: InventoryWalk[];
    status?: Partial<InventorySyncStatus>;
  };
  backSync?: {
    status?: Partial<BackSyncStatus>;
    missed?: MissedShipment[] | null;
    shipments?: NavShipmentHeader[];
    newestDtcShipmentAt?: string | null; // Unit 2 has-work gate (null => caught up default)
  };
  priceSync?: Partial<PriceSyncStatus>;
  jobQueue?: Partial<JobQueueHealthStatus>;       // middleware cross-check only (Unit 1)
  jobQueueState?: Partial<NavJobQueueState>;      // NAV-authoritative job-queue signals (Unit 1)
  webhook?: ShopifyWebhookStatus;
  allocator?: Partial<AllocatorStatus>;
  orders?: NavOrderLifecycleRow[];
}

function greenWalks(now: number): InventoryWalk[] {
  return [
    { walk_at: agoIso(600, now), processed: 1200, pushed: 118, skipped: 1082, untracked_filtered: 0 },
    { walk_at: agoIso(8000, now), processed: 1190, pushed: 121, skipped: 1069, untracked_filtered: 0 },
  ];
}

// A read-only NavClient backed entirely by the seed. No live query is ever issued.
class SeededNavClient implements NavClient {
  constructor(private readonly seed: BoardSeed, private readonly now: number) {}

  async getInventoryWatermarkState(): Promise<NavWatermarkState> {
    return {
      navNewestIabcEntryNo: 105_000,
      watermarkEntryNo: 104_988,
      lastWalkAt: agoIso(600, this.now), // fresh: well under one ~2h cycle
      watcherHeartbeatAt: agoIso(120, this.now), // alive
      ...this.seed.inventory?.watermark,
    };
  }
  async getRecentInventoryWalks(): Promise<InventoryWalk[]> {
    return this.seed.inventory?.walks ?? greenWalks(this.now);
  }
  async getOrderLifecycleRows(): Promise<NavOrderLifecycleRow[]> {
    return this.seed.orders ?? [];
  }
  async getRecentShipments(): Promise<NavShipmentHeader[]> {
    return this.seed.backSync?.shipments ?? [];
  }
  async getJobQueueState(): Promise<NavJobQueueState> {
    // Default healthy: auto-release firing minutes ago, no in-process job, an empty
    // Status=0 pending-promotion backlog. A test overrides only what it exercises.
    return {
      autoReleaseFiredAt: agoIso(300, this.now),
      oldestInProcessJobAt: null,
      inProcessJobCount: 0,
      pendingStagingCount: 0,
      ...this.seed.jobQueueState,
    };
  }
  async getNewestDtcShipmentAt(): Promise<string | null> {
    // Default: a DTC shipment posted BEFORE the default back-sync watermark
    // (agoIso 600), so the has-work gate reads caught-up (idle-green). A test
    // overrides this to a time newer than the watermark to exercise unsynced work.
    return this.seed.backSync?.newestDtcShipmentAt ?? agoIso(900, this.now);
  }
  async queryReadOnly<T>(): Promise<T[]> {
    return [];
  }
}

// A read-only MiddlewareClient backed entirely by the seed. GET-only semantics; no
// method here can mutate the middleware (design.md section 0).
class SeededMiddlewareClient implements MiddlewareClient {
  constructor(private readonly seed: BoardSeed, private readonly now: number) {}

  async getActivity(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async getErrors(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async getJobQueueHealth(): Promise<Record<string, unknown>> {
    return {};
  }
  async getMissedShipments(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async getStuckStaging(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async getPendingFulfillment(): Promise<Record<string, unknown>[]> {
    return [];
  }
  async getInventorySyncStatus(): Promise<InventorySyncStatus> {
    return {
      dryRunWouldPush: 130,
      dryRunAt: agoIso(3600, this.now),
      totalPairs: 12_218,
      ...this.seed.inventory?.status,
    };
  }
  async getAllocatorStatus(): Promise<AllocatorStatus> {
    return {
      lastDecisionAt: agoIso(90, this.now),
      serviceHeartbeatAt: agoIso(45, this.now),
      windowSeconds: 300,
      decisionsWindow: 50,
      splitCount: 9,
      unallocatableCount: 0,
      failedCount: 0,
      atpFallbackCount: 2,
      recentDecisions: [],
      ...this.seed.allocator,
    };
  }
  async getJobQueueHealthStatus(): Promise<JobQueueHealthStatus> {
    return {
      verdict: 'green', // CU 50007/50009 healthy: the job queue is completing
      autoReleaseFiredAt: agoIso(300, this.now),
      longestRunningJobS: 45,
      stuckJobCount: 0,
      checkedAt: agoIso(30, this.now),
      ...this.seed.jobQueue,
    };
  }
  async getPriceSyncStatus(): Promise<PriceSyncStatus> {
    return {
      lastReceivedAt: agoIso(600, this.now),
      lastRunAt: agoIso(300, this.now),
      ...this.seed.priceSync,
    };
  }
  async getShopifyWebhookStatus(): Promise<ShopifyWebhookStatus> {
    return (
      this.seed.webhook ?? {
        topics: [
          { topic: 'orders/create', lastReceivedAt: agoIso(400, this.now), subscribed: true },
          { topic: 'fulfillments/create', lastReceivedAt: agoIso(700, this.now), subscribed: true },
        ],
      }
    );
  }
  async getBackSyncStatus(): Promise<BackSyncStatus> {
    return {
      lastBackSyncAt: agoIso(600, this.now),
      watcherHeartbeatAt: agoIso(120, this.now),
      fulfillmentsLast24h: 210,
      errorsLast24h: 0,
      ...this.seed.backSync?.status,
    };
  }
  async getMissedShipmentDetail(): Promise<MissedShipment[] | null> {
    // Default: queried and found none (a genuine green), not null (unknown).
    return this.seed.backSync?.missed ?? [];
  }
}

// Build a whole-board read-only Sources from a seed. Omitted pipes default green.
export function makeSeededSources(seed: BoardSeed = {}): Sources {
  const now = seed.now ?? Date.now();
  return {
    nav: new SeededNavClient(seed, now),
    middleware: new SeededMiddlewareClient(seed, now),
  };
}

// --- Order-row seed helpers (the Shopify-to-NAV join, design.md 3.1 / 4) -----

// A fully-shipped, backsynced DTC order: every hop complete => green.
export function greenDtcOrder(navOrderNo: string, now: number = Date.now()): NavOrderLifecycleRow {
  return {
    channel: 'dtc',
    navOrderNo,
    webId: `web-${navOrderNo}`,
    webOrder: 1, // a web order (WebOrder = 1 on the NAV Sales Header)
    shopifyOrderName: `#${navOrderNo}`,
    customerRef: 'CUST-001 Acme',
    shopifyOrderAt: agoIso(9000, now),
    allocatorSplitAt: agoIso(8900, now),
    navStagingAt: agoIso(8800, now),
    navStagingStatus: 0,
    navPromotionAt: agoIso(8700, now),
    navShipmentAt: agoIso(3600, now),
    backSyncAt: agoIso(1800, now),
    missedBackSync: false,
  };
}

// A wholesale order (NAV-originated, no WebId, no Shopify leg). Fully shipped =>
// green. It has NO shopify_order / allocator_split / back_sync hop, so it can
// never be graded an orphan for lacking a WebId (design.md 4).
export function greenWholesaleOrder(
  navOrderNo: string,
  now: number = Date.now(),
): NavOrderLifecycleRow {
  return {
    channel: 'wholesale',
    navOrderNo,
    webId: null, // wholesale correctly has no WebId
    webOrder: 0, // not a web order => never an orphan
    shopifyOrderName: null,
    customerRef: 'WH-2050 Big Box Retail',
    shopifyOrderAt: null,
    allocatorSplitAt: null,
    navStagingAt: null,
    navStagingStatus: null,
    navPromotionAt: agoIso(9000, now),
    navShipmentAt: agoIso(3600, now),
    backSyncAt: null,
    missedBackSync: false,
  };
}

// A DTC order stuck in NAV staging with a nonzero (blocked) status and no
// promotion: a latched error at nav_staging => RED (design.md 5).
export function stuckStagingDtcOrder(
  navOrderNo: string,
  now: number = Date.now(),
): NavOrderLifecycleRow {
  return {
    channel: 'dtc',
    navOrderNo,
    webId: `web-${navOrderNo}`,
    webOrder: 1, // a web order (WebOrder = 1 on the NAV Sales Header)
    shopifyOrderName: `#${navOrderNo}`,
    customerRef: 'CUST-777 Blocked',
    shopifyOrderAt: agoIso(9000, now),
    allocatorSplitAt: agoIso(8900, now),
    navStagingAt: agoIso(8800, now),
    navStagingStatus: 1, // Blocked = 1 SKU (design.md 5): promotion errored
    navPromotionAt: null,
    navShipmentAt: null,
    backSyncAt: null,
    missedBackSync: false,
  };
}
