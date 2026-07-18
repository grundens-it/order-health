# Kickoff: Add OOS-held detection + correct remediation routing to Order Health

> Grundens orchestrate round. Repo `grundens-it/order-health`. Work on `dev/oos-held` off `main`, open a PR, do not push to `main` or merge. Read-only NAV/middleware except the already-gated remediation endpoints (behind `REMEDIATION_LIVE_ENABLED`, unchanged). Pure compute functions with unit tests; thresholds in `config.ts`, env-tunable, same as `allocator.ts` / `inventorySync.ts`. No em dashes. Umbrella #86 (WI1 #87, WI2 #88, WI3 #89).

## Why (the 2026-07-17 incident this must catch)

~173 DTC orders were stranded in the middleware `oos_held_order` queue after a limited-edition drop (Taxman, style `50625-425`, stocked only at Holman / `HF1FTZ`). Root cause: for a ~10-hour window the fulfillment-service (Holman) per-location availability momentarily read 0 while NAV had full stock, so the allocator's inventory-aware fallback bounced orders to TAC (genuinely empty) and dropped the lines to `OutOfStock`, parking them in `oos_held_order`. The catalog inventory-sync pipe was green the entire time, so nothing on the dashboard lit up. The failure surfaced only as a customer-service escalation.

Order Health already fetches `GET /api/oos-held` and folds its length into `unallocatableCount` on the allocator pipe's split-sanity ratio, but that is not enough: it is bucketed as generic "unallocatable / no ATP", there is no detector for the actual leading cause, and remediation is not correctly conditioned (a plain re-drive no-ops on most of these orders). Fix all three.

## Work item 1 (#87) - First-class OOS-held backlog signal

Promote the OOS-held backlog from a buried count to its own graded signal.

- Read `GET /api/oos-held?limit=300`. Row shape: `order_id` (Shopify numeric id), `order_name` (e.g. `SP-322348`), `class` (`transient` | `backorder`), `status` (`pending` | `resolved` | `needs_operator`), `attempts`, `first_seen_at`, `last_attempt_at`, `last_detail`.
- Grade on queue depth and age of the `needs_operator` rows (env-tunable amber/red thresholds in `config.ts`, following the allocator threshold block). `backorder`-class rows are legitimate and must never drive red. `transient` + `needs_operator` is the alerting population.
- Surface the order list with `last_detail` and age so an operator sees the count, the oldest, and the reason.
- Independent of the allocator split-sanity ratio; keep that, but add this as its own pipe/signal so a backlog is named, not inferred.

## Work item 2 (#88) - Per-location availability divergence detector (the leading indicator)

Add the signal that would have fired at hour 0 of the incident instead of after 173 orders piled up.

- For each active SKU, compare NAV IABC availability at `HF1FTZ` (via `navClient.getInventoryAvailability`, columns `Qty Available`, `Qty On Hand`, `Earliest Shipment Date`) against the middleware's fulfillment-service / per-location availability for that SKU. Flag SKUs where NAV shows stock at `HF1FTZ` (`Qty Available > 0`, `Earliest Shipment Date <= today`) but the FS-location availability reads 0. That divergence is the exact condition that caused the incident.
- MUST be separate from the catalog inventory-sync freshness/liveness pipe, which was green during the incident. Do not fold it into that pipe.
- Data sources: `sources/navClient.ts` IABC for the NAV side; middleware for the FS-location side. Available middleware GET reads: `/api/nav/inventory-sync/fulfillment-service-info`, `/api/shopify/locations`, `/api/nav/inventory/check`, and the `inventory_sync` history. If no single clean per-location availability read exists, use the closest proxy, document it, and flag a follow-up rather than inventing one.
- Location GIDs: Holman warehouse `gid://shopify/Location/90764378361`, Grundens Fulfillment Service `gid://shopify/Location/90867171577`, TAC `gid://shopify/Location/67890249977`.

## Work item 3 (#89) - Correct, conditioned remediation routing

The naive fix is wrong and was proven wrong live. Route remediation by NAV state, not blindly.

Middleware idempotency rule (`orders_updated.rs`): re-driving an order via `POST /api/forward-sync/replay` returns `DuplicateSkip` when allocations exist AND the order is already in NAV; it only falls through and re-stages when allocations exist but the order is NOT in NAV. Empirically, of the 173 held: 40 are not in NAV (re-drive works), 52 are in NAV with the dropped line missing (re-drive no-ops, needs a manual NAV line-add, the middleware has no endpoint for this), and 81 are in NAV with the line present (stale hold record).

So the OOS-held signal must join each held order to NAV (`GRUS$Sales Header` presence by `[No_] LIKE order_name + '-%'`, and whether the dropped SKU line exists in `GRUS$Sales Line`) and bucket it, then attach the right action:

- Not in NAV: `forward_sync_replay` (`POST /api/forward-sync/replay` `{ "shopify_order_id": <i64> }`, un-gated). Valid.
- In NAV, dropped line missing: an `ops_runbook` tool "add the dropped line to the NAV sales order" (no middleware endpoint exists; auto-recovery of partial lines is unsupported).
- In NAV, line present: stale hold, an ops step to verify and clear.
- Do NOT map `forward_sync_replay` to in-NAV held orders. Add a unit test that encodes the duplicate-skip gotcha.

Root-cause remediation for the WI2 divergence signal: wire `POST /api/nav/inventory-sync/fulfillment-service-floor` (and `-floor-one`, `-floor-progress`, and `fulfillment-service-sweep`) as a `middleware_endpoint` tool that re-floors the FS-location inventory. Gated by `NAV_TOGGLE_PASSWORD`, dry-run defaults on; respect the existing gated-tool wiring in `remediation/registry.ts` + `remediationClient.ts`.

## Acceptance criteria

- The OOS-held signal and the per-location divergence signal both appear on the pipeline strip and grade red at 2026-07-17 backlog/divergence levels.
- Held orders are bucketed re-drivable vs manual-add vs stale, each with the correct mapped remediation; `forward_sync_replay` is never offered on an in-NAV order.
- Pure compute + unit tests in the existing style; thresholds in `config.ts`, env-tunable; a test encoding the replay duplicate-skip rule.
- No behavior change to existing pipes; NAV + middleware reads stay read-only; remediation stays behind `REMEDIATION_LIVE_ENABLED`.
- `docs/DATA_SOURCES.md` updated with the `oos_held_order` schema, the FS-location divergence source, and the duplicate-skip rule.

## Endpoints referenced (all confirmed live on the middleware)

Reads: `GET /api/oos-held`, `GET /api/nav/inventory-sync/fulfillment-service-info`, `GET /api/shopify/locations`, `GET /api/nav/inventory/check`. Actions: `POST /api/forward-sync/replay` (per order), `POST /api/forward-sync/bulk-replay` (`{from,to}` window), `POST /api/nav/inventory-sync/fulfillment-service-floor` / `-floor-one` / `fulfillment-service-sweep` (gated).

## Paste-ready /goal

/goal Run the OOS-held detection + remediation-routing round in grundens-it/order-health per docs/kickoffs/oos-held-detection.md, on dev/oos-held off main. WI1 (#87): add a first-class OOS-held backlog signal reading GET /api/oos-held?limit=300, graded on transient+needs_operator depth/age with env-tunable amber/red thresholds in config.ts (allocator-style), backorder-class never red, surfacing the order list with last_detail and age, independent of the allocator split-sanity ratio. WI2 (#88): add a per-location availability divergence detector comparing NAV IABC at HF1FTZ (Qty Available>0, Earliest Shipment Date<=today) vs the middleware FS-location availability reading 0, as its OWN signal separate from inventory-sync; use the closest documented middleware read and flag a follow-up if no clean per-location read exists. WI3 (#89): join each held order to NAV (GRUS$Sales Header presence by [No_] LIKE order_name+'-%'; dropped SKU line in GRUS$Sales Line), bucket not-in-NAV / in-NAV-line-missing / in-NAV-line-present, map forward_sync_replay ONLY to not-in-NAV, an ops_runbook manual-NAV-line-add to line-missing, a stale-hold ops step to line-present, with a unit test encoding the duplicate-skip rule; wire fs-floor (fulfillment-service-floor/-floor-one/-progress/-sweep) as the gated middleware_endpoint tool for the WI2 divergence. Pure compute + node:test unit tests in the existing seam style; thresholds in config.ts env-tunable; NAV/middleware read-only; remediation stays behind REMEDIATION_LIVE_ENABLED. Update docs/DATA_SOURCES.md with the oos_held_order schema, the FS-location divergence source, and the duplicate-skip rule. Verify npm run typecheck then npm test. Commit per work item referencing its issue; push dev/oos-held; open a PR closing #86/#87/#88/#89. Do not push to main or merge.
