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
  nav: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    encrypt: boolean;
  };
  aggregator: {
    enabled: boolean;
    // Conservative cadences (ADR-0002): order layer every 2 to 5 minutes,
    // inventory layer aligned to the ~2h IABC cycle. Cron expressions.
    orderLayerCron: string;
    inventoryLayerCron: string;
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
  nav: {
    host: str('NAV_HOST'),
    port: Number(str('NAV_PORT', '1433')),
    database: str('NAV_DATABASE'),
    user: str('NAV_USER'),
    password: str('NAV_PASSWORD'),
    encrypt: bool('NAV_ENCRYPT', true),
  },
  aggregator: {
    enabled: bool('AGGREGATOR_ENABLED', true),
    orderLayerCron: str('ORDER_LAYER_CRON', '*/3 * * * *'),
    inventoryLayerCron: str('INVENTORY_LAYER_CRON', '0 */2 * * *'),
  },
  inventorySync: {
    // Defaults: green under one cycle, amber one to two cycles, red beyond.
    cycleSeconds: num('INVENTORY_CYCLE_SECONDS', 7200), // ~2h IABC cycle
    freshnessAmberCycles: num('INVENTORY_FRESHNESS_AMBER_CYCLES', 1),
    freshnessRedCycles: num('INVENTORY_FRESHNESS_RED_CYCLES', 2),
    livenessAmberCycles: num('INVENTORY_LIVENESS_AMBER_CYCLES', 1),
    livenessRedCycles: num('INVENTORY_LIVENESS_RED_CYCLES', 2),
    // 7,245 / 466 ~= 15.5 (the part-1 case) trips amber at 5x; never escalates to red.
    divergenceAmberRatio: num('INVENTORY_DIVERGENCE_AMBER_RATIO', 5),
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
};

// True only when a Postgres URL is configured. When false, the read API serves
// from the in-memory stub layer so the scaffold runs without a live DB.
export const hasDatabase = (): boolean => config.database.url.length > 0;
