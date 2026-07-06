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
};

// True only when a Postgres URL is configured. When false, the read API serves
// from the in-memory stub layer so the scaffold runs without a live DB.
export const hasDatabase = (): boolean => config.database.url.length > 0;
