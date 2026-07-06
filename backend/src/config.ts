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
  order: {
    // OFF until BA question 1 resolves what marks a NAV order as wholesale.
    orphanGradingEnabled: bool('ORDER_ORPHAN_GRADING_ENABLED', false),
    stageAmberSeconds: num('ORDER_STAGE_AMBER_SECONDS', 1800),          // 30 min (design.md 5)
    stageRedSeconds: num('ORDER_STAGE_RED_SECONDS', 3600),             // 60 min
    awaitingShipAmberSeconds: num('ORDER_AWAITING_SHIP_AMBER_SECONDS', 86400),  // 24h
    awaitingShipRedSeconds: num('ORDER_AWAITING_SHIP_RED_SECONDS', 259200),     // 72h
  },
};

// True only when a Postgres URL is configured. When false, the read API serves
// from the in-memory stub layer so the scaffold runs without a live DB.
export const hasDatabase = (): boolean => config.database.url.length > 0;
