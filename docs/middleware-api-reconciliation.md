# Middleware API reconciliation (working analysis)

Status: **in progress.** Reconstructed 2026-07-06 after a crash. Compares what
`backend/src/sources/middlewareClient.ts` *assumes* against the **real** routes
the Symmetry warehouse-splitter middleware exposes.

Source of truth (private repo `grundens/SymmetryCommerce-GrundensWarehouseSplitterMiddleware`, `main`):
- `middleware/Backend/src/main.rs` — warp route table (authoritative API surface).
- `middleware/Backend/src/dashboard.rs` — activity/errors/orders-today/oos-held handlers.
- `middleware/Backend/src/recovery.rs` — `POST /api/recovery/replay-fulfillment-requests`.

Key structural fact: the middleware is a `warp` server backed by **SQLite** tables
(`inventory_sync`, `price_sync`, `nav_shipment_sync`, `shopify_webhook_event`,
`shopify_event_log`, `warehouse_allocation_log`, `oos_held`, job-queue views).
It exposes **per-source feeds/recents/analytics**, NOT one "status" object per pipe.
So most of our per-pipe `getXStatus()` methods have no 1:1 endpoint — they must be
composed from the real endpoints, or the aggregation must be ported into our app.

## Endpoint reconciliation

| Our client method | Assumed path | Real middleware route | Verdict |
|---|---|---|---|
| `getActivity` | `GET /api/dashboard/activity` | `GET /api/activity/recent?limit=N` (main.rs:1107) | ⚠️ wrong path; shape = `ActivityItem[]` |
| `getErrors` | `GET /api/dashboard/errors` | `GET /api/errors?days=&page=&page_size=` (1117); count at `/api/errors/count` (1122) | ⚠️ wrong path; shape = `{days,page,page_size,total,rows:ActivityItem[]}` |
| `getJobQueueHealthStatus` | `GET /api/nav/job-queue/health` | `GET /api/nav/job-queue/health` (536) | ✅ exists — confirm response shape |
| `getMissedShipmentDetail` | `GET /api/back-sync/missed-shipments` | `GET /api/back-sync/missed-shipments` (545) | ✅ exists — confirm shape |
| `getStuckStaging` | `GET /api/nav/stuck-staging` | `GET /api/nav/stuck-staging` (555) | ✅ exists |
| `getPendingFulfillment` | `GET /api/fulfillment/pending` | `GET /api/middleware/pending-fulfillment-requests` (1054) | ⚠️ wrong path |
| `getBackSyncStatus` | `GET /api/back-sync/status` | ❌ none. Compose from `GET /api/nav/back-sync/feed?limit=N` (195) + `/api/nav/back-sync/settings` (206) | 🔴 not exposed — derive watermark/heartbeat/24h counters from the feed |
| `getInventorySyncStatus` | `GET /api/inventory-sync/status` | ❌ none. Real: `/api/nav/inventory-sync/dry-run` (385), `/analytics` (376), `/progress` (268), `/recent` (369) | 🔴 dryRunWouldPush/totalPairs come from the **dry-run** endpoint |
| `getPriceSyncStatus` | `GET /api/price-sync/status` | ❌ none. Real: `/api/nav/price-sync/recent` (444), `/analytics` (450) | 🔴 last-received/last-run must be derived |
| `getShopifyWebhookStatus` | `GET /api/webhooks/shopify/health` | ❌ none. Real: `/api/shopify/webhooks/subscriptions` (973), `/api/shopify/webhooks/events` (977) | 🔴 compose per-topic freshness + subscribed state from these two |
| `getAllocatorStatus` | `GET /api/allocator/status` | ❌ none. Related: `/api/warehouse/allocation/inventory-audit` (694), `/api/oos-held` (1127), `/api/warehouse/tester-override/runs` (779), `/api/warehouse/rollout/audit` (685) | 🔴 **biggest gap** — no window-count status; `unallocatable` ≈ `oos-held`; splits/failed/atp-fallback likely need porting the `warehouse_allocation_log` aggregation |

## Remediation "tool detection" — the real recovery tools

`registry.ts` currently maps every back-sync/missed-fulfillment subject to a single
static `recovery_sweep` tool pointed at `POST /api/recovery/fulfillments` — a path
that **does not exist**. The real middleware has *several* recovery tools; picking
the right one is the "tool detection" work:

| Real tool | Route | Semantics |
|---|---|---|
| Replay fulfillment requests (batch) | `POST /api/recovery/replay-fulfillment-requests` (1042) | Body `{shopify_order_ids:[i64], password, set_by}`; **batch ≤200**; per-order result; auth via `NAV_TOGGLE_PASSWORD`; runs `submit_fulfillment_requests_for_order` (defined in `orders_updated.rs`, not recovery.rs) |
| Submit single fulfillment request | `POST /api/middleware/submit-fulfillment-request` (1059) | single-order variant |
| Pending fulfillment requests (diagnostic) | `GET /api/middleware/pending-fulfillment-requests` (1054) | read-only backlog list |
| Back-sync run-now | `POST /api/back-sync/run-now` (581) | force a back-sync pass |
| Back-sync rescan-from | `POST /api/back-sync/rescan-from` (594) | rescan window |
| Close unfulfilled FOs | `POST /api/order-recovery/close-unfulfilled-fos` (841) | close degenerate FulfillmentOrders |
| Stuck-staging dedupe | `POST /api/nav/stuck-staging/dedupe` (570) | resolve duplicate staging rows |

### Confirmed bug — remediation popup `recovery_sweep`
`backend/src/remediation/registry.ts` (~line 25):
- **Path wrong:** `POST /api/recovery/fulfillments` → should be `POST /api/recovery/replay-fulfillment-requests`.
- **Contract wrong:** description says "for the order" (single) — real endpoint is a **batch** of `shopify_order_ids` with a required `password`/`set_by` and a 200-order cap.
- **Source annotation misleading:** `submit_fulfillment_requests_for_order` lives in `shopify/webhook_handlers/orders_updated.rs`; the endpoint handler is `recovery.rs::handle_replay`.

## Open items / next steps
1. Fix the `recovery_sweep` tool path + description in `registry.ts` (concrete, ready).
2. Decide the tool-detection model: inspect the runtime failure mode (e.g. inventory_sync liveness vs watermark-stale-but-alive vs dry-run-divergence) and select the correct real tool instead of the static primary.
3. For each 🔴 tile, decide compose-from-real-endpoints vs port-the-aggregation:
   - back_sync ← feed
   - inventory_sync ← dry-run
   - price_sync ← recent/analytics
   - shopify_webhook ← subscriptions + events
   - allocator ← warehouse_allocation_log aggregation (needs porting) + oos-held
4. Confirm response shapes for the ✅ endpoints (job-queue/health, missed-shipments, stuck-staging) by reading their handlers.
</content>
</invoke>
