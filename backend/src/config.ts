// Centralized, typed configuration loaded from the environment (.env.example
// documents every key). No secrets are hard-coded; read-only source access is
// provisioned by DevOps and injected here.
import 'dotenv/config';

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    // Missing config is not fatal at scaffold time: the aggregator is gated on
    // DevOps provisioning and the API falls back to the stub layer without a DB.
    return '';
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.length === 0) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface Config {
  server: { host: string; port: number };
  database: { url: string };
  middleware: { baseUrl: string; authToken: string };
  // Read-only Shopify Admin API (ADR-0009). Client-credentials custom-app token,
  // least-privilege READ scopes only. The client is live only when shop + clientId
  // + clientSecret are all present; otherwise the read-only stub answers and the
  // storefront reconciliations read 'unknown'. The secret lives only in the
  // gitignored .env / host secret store, never committed.
  shopify: {
    authMode: string;     // SHOPIFY_AUTH_MODE (client_credentials)
    shop: string;         // SHOPIFY_SHOP (the myshopify domain)
    apiVersion: string;   // SHOPIFY_API_VERSION (e.g. 2025-01)
    clientId: string;     // SHOPIFY_CLIENT_ID
    clientSecret: string; // SHOPIFY_CLIENT_SECRET (secret; gitignored)
  };
  nav: {
    host: string;
    port: number;
    database: string;
    encrypt: boolean;
    // Microsoft Entra (Azure AD) auth. The NAV box has NO SQL user/password.
    // authMode selects the mssql/tedious authentication type (DATA_SOURCES.md):
    //   aad-default | aad-service-principal | aad-msi
    authMode: string;
    aadTenantId: string;   // service-principal only
    aadClientId: string;   // service-principal only
    aadClientSecret: string; // service-principal only
    // Company code for the multi-company NAV DB. Every table is prefixed
    // `${company}$` (GRUS = Grundens US) so we never read another company's data.
    company: string;
    orderIngestLimit: number;
  };
  aggregator: {
    enabled: boolean;
    // Conservative cadences (ADR-0002): order layer every 2 to 5 minutes,
    // inventory layer aligned to the ~2h IABC cycle. Cron expressions.
    orderLayerCron: string;
    inventoryLayerCron: string;
  };
  // Remediation (Unit 7 + ADR-0010 executable Tier 1). OPERATOR-triggered only.
  // The operator token gates the POST trigger endpoint in THIS service. The
  // executable path is DISARMED by default: liveEnabled must be explicitly true
  // AND killSwitch false for any live middleware call to fire; otherwise every
  // trigger returns 'would_trigger' exactly as the stub did. togglePassword is the
  // NAV write-gate the middleware requires on its gated endpoints (recovery
  // replay), sent ONLY on those and NEVER logged. This service never arms itself:
  // arming is a deliberate, out-of-band posture (ADR-0010), never a UI toggle.
  remediation: {
    operatorToken: string;
    liveEnabled: boolean;   // REMEDIATION_LIVE_ENABLED (default false = disarmed)
    killSwitch: boolean;    // REMEDIATION_KILL_SWITCH (default false; true forces disarmed)
    togglePassword: string; // NAV_TOGGLE_PASSWORD (sent only on gated endpoints; never logged)
  };
  // Inventory Sync Monitor thresholds (design.md 5A). Never hardcoded: the three
  // verdict bands (freshness, liveness, dry-run divergence) are all tuned here so
  // Ops owns the numbers. All cycle-based bands are multiples of cycleSeconds.
  inventorySync: {
    cycleSeconds: number;          // one IABC cycle (~2h)
    freshnessAmberCycles: number;  // watermark lag >= this many cycles => AMBER
    freshnessRedCycles: number;    // watermark lag >= this many cycles => RED
    livenessAmberCycles: number;   // heartbeat age >= this many cycles => AMBER
    livenessRedCycles: number;     // heartbeat age >= this many cycles => RED
    divergenceAmberRatio: number;  // (dry-run would-push / trailing live push) above this => AMBER (never RED)
  };
  // Order-lifecycle grading thresholds (design.md 3.1 / 5). Ops owns the SLO
  // bands; the orphan flag is gated on a BA clarification (see below).
  order: {
    // ORPHAN GRADING GATE. Default FALSE, pending BA open question 1 (orphan vs
    // wholesale disambiguation, design.md section 9). While false, no DTC order
    // is flagged an orphan; wholesale is never flagged regardless of this flag.
    orphanGradingEnabled: boolean;
    stageAmberSeconds: number;        // in-flight at a staging/promotion hop >= this => AMBER
    stageRedSeconds: number;          // >= this => RED
    awaitingShipAmberSeconds: number; // promoted, no shipment >= this => AMBER
    awaitingShipRedSeconds: number;   // >= this => RED
  };
  // Allocator (Warehouse Split) monitor thresholds (Unit 4, design.md 3.2 / 5).
  // Freshness + liveness are cycle-banded (multiples of cycleSeconds); the
  // split-sanity signal is ratio-banded. All Ops-tunable, never hardcoded.
  allocator: {
    cycleSeconds: number;          // one allocator decision window (~5m)
    freshnessAmberCycles: number;  // decision lag >= this many cycles => AMBER
    freshnessRedCycles: number;    // decision lag >= this many cycles => RED
    livenessAmberCycles: number;   // heartbeat age >= this many cycles => AMBER
    livenessRedCycles: number;     // heartbeat age >= this many cycles => RED
    failedAmberRatio: number;      // (unallocatable + failed) / decisions above this => AMBER
    failedRedRatio: number;        // ...above this => RED
  };
  // Unit 3 thresholds. Ops owns the numbers; the code reads them.
  // price_sync (design.md 3): freshness (last received) + liveness (last run),
  // both cycle-banded like inventory-sync.
  priceSync: {
    cycleSeconds: number;
    freshnessAmberCycles: number;
    freshnessRedCycles: number;
    livenessAmberCycles: number;
    livenessRedCycles: number;
  };
  // nav_job_queue (ADR-0007, health-fidelity Unit 1): the verdict is COMPUTED
  // from read-only NAV, not adopted from the middleware. Three independent bands:
  //   liveness    - recency of the last CU 50009 auto-release firing.
  //   stuck-job   - a genuinely stuck in-process CU 50007 (a normal IABC run is
  //                 20 to 47 min, so the threshold sits near 60 min, never under).
  //   staging     - real GRUS$Sales Header Staging rows with Status = 0 pending
  //                 promotion (NOT the Status = 1 "Not Auto-released" old rows).
  // The middleware's own number is kept only as a labelled cross-check.
  jobQueue: {
    stuckJobWarnSeconds: number;         // legacy label for the middleware cross-check
    autoReleaseAmberSeconds: number;     // last CU 50009 auto-release age >= this => AMBER
    autoReleaseRedSeconds: number;       // ...>= this => RED
    inProcessAmberSeconds: number;       // CU 50007 in-process age >= this => AMBER (>= ~60 min)
    inProcessRedSeconds: number;         // ...>= this => RED
    pendingStagingAmberCount: number;    // real Status=0 pending-promotion rows >= this => AMBER
    pendingStagingRedCount: number;      // ...>= this => RED
  };
  // shopify_webhook (design.md 5): per-topic last-received freshness bands. A
  // removed subscription is amber-or-worse by rule (not a tunable band).
  shopifyWebhook: {
    cycleSeconds: number;
    freshnessAmberCycles: number;
    freshnessRedCycles: number;
  };
  // Back-sync monitor thresholds (Unit 2, design.md 3.2 / 5 "Missed back-sync").
  // Freshness = age of the last successful fulfillmentCreate; liveness = back-sync
  // watcher heartbeat age; both cycle-banded. The missed-shipments signal is
  // count-banded and, unlike inventory divergence, may reach RED. Ops owns all
  // numbers; nothing is hardcoded.
  backSync: {
    cycleSeconds: number;          // one back-sync cycle in seconds
    freshnessAmberCycles: number;  // watermark lag >= this many cycles => AMBER
    freshnessRedCycles: number;    // watermark lag >= this many cycles => RED
    livenessAmberCycles: number;   // heartbeat age >= this many cycles => AMBER
    livenessRedCycles: number;     // heartbeat age >= this many cycles => RED
    missedWindowDays: number;      // lookback window for the missed-shipments count
    missedAmberCount: number;      // missed count >= this => AMBER
    missedRedCount: number;        // missed count >= this => RED (real backlog)
  };
}

export const config: Config = {
  server: {
    host: str('HOST', '0.0.0.0'),
    port: Number(str('PORT', '8080')),
  },
  database: {
    url: str('DATABASE_URL'),
  },
  middleware: {
    baseUrl: str('MIDDLEWARE_BASE_URL'),
    authToken: str('MIDDLEWARE_AUTH_TOKEN'),
  },
  shopify: {
    authMode: str('SHOPIFY_AUTH_MODE', 'client_credentials'),
    shop: str('SHOPIFY_SHOP'),
    apiVersion: str('SHOPIFY_API_VERSION', '2025-01'),
    clientId: str('SHOPIFY_CLIENT_ID'),
    clientSecret: str('SHOPIFY_CLIENT_SECRET'),
  },
  nav: {
    host: str('NAV_HOST'),
    port: Number(str('NAV_PORT', '1433')),
    database: str('NAV_DATABASE'),
    encrypt: bool('NAV_ENCRYPT', true),
    // Entra auth (no SQL user/password on this server). Default to aad-default
    // so local dev works after `az login`.
    authMode: str('NAV_AUTH_MODE', 'aad-default'),
    aadTenantId: str('NAV_AAD_TENANT_ID'),
    aadClientId: str('NAV_AAD_CLIENT_ID'),
    aadClientSecret: str('NAV_AAD_CLIENT_SECRET'),
    company: str('NAV_COMPANY', 'GRUS'),
    // How many most-recent orders the aggregator ingests from NAV into the
    // snapshot. The UI defaults to showing 100 and lets the operator raise the
    // displayed count up to this cap, so ingest at least that many.
    orderIngestLimit: num('NAV_ORDER_INGEST_LIMIT', 1000),
  },
  aggregator: {
    enabled: bool('AGGREGATOR_ENABLED', true),
    orderLayerCron: str('ORDER_LAYER_CRON', '*/3 * * * *'),
    inventoryLayerCron: str('INVENTORY_LAYER_CRON', '*/5 * * * *'),
  },
  remediation: {
    operatorToken: str('REMEDIATION_OPERATOR_TOKEN'),
    // DISARMED by default (ADR-0010). Both must line up for a live call: armed
    // (liveEnabled true) AND not kill-switched. Never armed in a committed .env.
    liveEnabled: bool('REMEDIATION_LIVE_ENABLED', false),
    killSwitch: bool('REMEDIATION_KILL_SWITCH', false),
    // The middleware's NAV write-gate password; empty until DevOps provisions it.
    togglePassword: str('NAV_TOGGLE_PASSWORD'),
  },
  inventorySync: {
    // Defaults: green under one cycle, amber one to two cycles, red beyond.
    cycleSeconds: num('INVENTORY_CYCLE_SECONDS', 7200), // ~2h IABC cycle
    freshnessAmberCycles: num('INVENTORY_FRESHNESS_AMBER_CYCLES', 1),
    freshnessRedCycles: num('INVENTORY_FRESHNESS_RED_CYCLES', 2),
    // Liveness widened to the real walk cadence (Unit 3, health-fidelity). Walks
    // run about every 2h (one cycle), so a heartbeat is legitimately up to one full
    // inter-walk gap old right before the next run. Amber at 2 missed cadences (~4h),
    // red at 3 (~6h), so a healthy 124-min heartbeat reads GREEN instead of flipping
    // amber right before every walk, while a genuine >4h stall still fires.
    livenessAmberCycles: num('INVENTORY_LIVENESS_AMBER_CYCLES', 2),
    livenessRedCycles: num('INVENTORY_LIVENESS_RED_CYCLES', 3),
    // 7,245 / 466 ~= 15.5 (the part-1 case) trips amber at 5x; never escalates to red.
    divergenceAmberRatio: num('INVENTORY_DIVERGENCE_AMBER_RATIO', 5),
  },
  order: {
    // OFF until BA question 1 resolves what marks a NAV order as wholesale.
    orphanGradingEnabled: bool('ORDER_ORPHAN_GRADING_ENABLED', false),
    stageAmberSeconds: num('ORDER_STAGE_AMBER_SECONDS', 1800),          // 30 min (design.md 5)
    stageRedSeconds: num('ORDER_STAGE_RED_SECONDS', 3600),             // 60 min
    awaitingShipAmberSeconds: num('ORDER_AWAITING_SHIP_AMBER_SECONDS', 86400),  // 24h
    awaitingShipRedSeconds: num('ORDER_AWAITING_SHIP_RED_SECONDS', 259200),     // 72h
  },
  allocator: {
    // Defaults: allocator decides on order intake, so a ~5m window; green under
    // 3 cycles (~15m), amber 3 to 6 cycles, red beyond ~30m (the job-queue SLO).
    cycleSeconds: num('ALLOCATOR_CYCLE_SECONDS', 300),
    freshnessAmberCycles: num('ALLOCATOR_FRESHNESS_AMBER_CYCLES', 3),
    freshnessRedCycles: num('ALLOCATOR_FRESHNESS_RED_CYCLES', 6),
    livenessAmberCycles: num('ALLOCATOR_LIVENESS_AMBER_CYCLES', 3),
    livenessRedCycles: num('ALLOCATOR_LIVENESS_RED_CYCLES', 6),
    // Un-allocatable / failed split share: amber above 5%, red above 15%.
    failedAmberRatio: num('ALLOCATOR_FAILED_AMBER_RATIO', 0.05),
    failedRedRatio: num('ALLOCATOR_FAILED_RED_RATIO', 0.15),
  },
  // Unit 3: price_sync. Default cycle 1h; green under 1 cycle, amber 1 to 2, red beyond.
  priceSync: {
    cycleSeconds: num('PRICE_SYNC_CYCLE_SECONDS', 3600),
    freshnessAmberCycles: num('PRICE_SYNC_FRESHNESS_AMBER_CYCLES', 1),
    freshnessRedCycles: num('PRICE_SYNC_FRESHNESS_RED_CYCLES', 2),
    livenessAmberCycles: num('PRICE_SYNC_LIVENESS_AMBER_CYCLES', 1),
    livenessRedCycles: num('PRICE_SYNC_LIVENESS_RED_CYCLES', 2),
  },
  // nav_job_queue (Unit 1, ADR-0007). Computed from read-only NAV. Defaults are
  // safe starting points surfaced for Ops to tune (health-fidelity kickoff s11):
  //   auto-release: healthy firings were 4 to 7 min apart in the live run, so
  //     amber at 30 min and red at 60 min flag a genuine stall without tripping on
  //     a normal quiet gap.
  //   in-process: a normal IABC (CU 50007) run is 20 to 47 min, so amber at 60 min
  //     and red at 90 min; never flag under 60 min (the false-"Stuck" the live run showed).
  //   pending staging: real Status=0 rows clear quickly; a standing backlog is the
  //     signal. Amber at 25, red at 100 (surfaced default; NOT the 1,988 Status=1 rows).
  jobQueue: {
    stuckJobWarnSeconds: num('JOB_QUEUE_STUCK_JOB_WARN_SECONDS', 1800),
    autoReleaseAmberSeconds: num('JOB_QUEUE_AUTO_RELEASE_AMBER_SECONDS', 1800),
    autoReleaseRedSeconds: num('JOB_QUEUE_AUTO_RELEASE_RED_SECONDS', 3600),
    inProcessAmberSeconds: num('JOB_QUEUE_IN_PROCESS_AMBER_SECONDS', 3600),
    inProcessRedSeconds: num('JOB_QUEUE_IN_PROCESS_RED_SECONDS', 5400),
    pendingStagingAmberCount: num('JOB_QUEUE_PENDING_STAGING_AMBER_COUNT', 25),
    pendingStagingRedCount: num('JOB_QUEUE_PENDING_STAGING_RED_COUNT', 100),
  },
  // Unit 3: shopify_webhook. Default expected-delivery window 1h; a removed
  // subscription is amber-or-worse regardless of these bands.
  shopifyWebhook: {
    cycleSeconds: num('WEBHOOK_CYCLE_SECONDS', 3600),
    freshnessAmberCycles: num('WEBHOOK_FRESHNESS_AMBER_CYCLES', 1),
    freshnessRedCycles: num('WEBHOOK_FRESHNESS_RED_CYCLES', 4),
  },
  backSync: {
    // Defaults: back-sync runs far more often than the ~2h IABC cycle, so one
    // cycle is 1h; green under one cycle, amber one to two, red beyond.
    cycleSeconds: num('BACK_SYNC_CYCLE_SECONDS', 3600),
    freshnessAmberCycles: num('BACK_SYNC_FRESHNESS_AMBER_CYCLES', 1),
    freshnessRedCycles: num('BACK_SYNC_FRESHNESS_RED_CYCLES', 2),
    livenessAmberCycles: num('BACK_SYNC_LIVENESS_AMBER_CYCLES', 1),
    livenessRedCycles: num('BACK_SYNC_LIVENESS_RED_CYCLES', 2),
    // One missed shipment in the window is AMBER (the demo's "Missed 14d: 1"); a
    // cluster (>= 5) is a real backlog and reds the pipe.
    missedWindowDays: num('BACK_SYNC_MISSED_WINDOW_DAYS', 14),
    missedAmberCount: num('BACK_SYNC_MISSED_AMBER_COUNT', 1),
    missedRedCount: num('BACK_SYNC_MISSED_RED_COUNT', 5),
  },
};

// True only when a Postgres URL is configured. When false, the read API serves
// from the in-memory stub layer so the scaffold runs without a live DB.
export const hasDatabase = (): boolean => config.database.url.length > 0;
