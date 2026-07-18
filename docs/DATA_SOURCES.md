# Data sources (confirmed live, read-only)

> Authored from Cowork on 2026-07-06 by querying the read-only NAV connector directly. These are facts, not assumptions. Everything here is READ-ONLY. This service adds no write or mutation path to NAV or to the middleware.

## Summary

The dashboard has two external read-only sources, and they are different things:

1. **The NAV "SQL box"** (Azure SQL) holds the NAV order, inventory, staging, shipment, and Job Queue data.
2. **The middleware HTTP endpoints** hold the middleware's OWN operational state (inventory-sync watermark, `nav_shipment_sync`, `warehouse_allocation_log`, the timestamped dashboard tables). This does NOT live in NAV.

Both are needed. The NAV source is fully specified below and is the unblocked one; start there.

## 1. NAV = the Azure SQL "SQL box"

"The SQL box" and NAV are the same database. Confirmed via the read-only connector:

| Fact | Value |
|---|---|
| Server | `sql-grus-prd-01.database.windows.net` |
| Port | `1433` |
| Encrypt | `true` |
| NAV 18 production DB | `sqldb-nav18-grus-prd-01`  (point the NAV client here) |
| Second read-only DB (reporting warehouse) | `sqldb-data-warehouse-prd-01` (same server, available if useful later) |
| Engine | Azure SQL Database (SQL Azure, v12) |
| Auth | Microsoft Entra (Azure AD). No SQL username/password exists. |
| Access | read-only, database-level |

### Auth: Entra, not user/password

`navClient` / `config.ts` currently assume `NAV_USER` + `NAV_PASSWORD`. That is wrong for this server. Rework to Entra (AAD):

- Local dev: `authentication: { type: 'azure-active-directory-default' }` in the `mssql`/`tedious` config. Works after `az login` with an account that has read access.
- Deployed: a managed identity (if the service is hosted in Azure) or a service principal (tenant + client id + secret) granted `db_datareader` on `sqldb-nav18-grus-prd-01`. Use `type: 'azure-active-directory-service-principal-secret'` or `'azure-active-directory-msi-app-service'`.

Granting that read-only Entra identity is the DevOps provisioning step that replaces the old password ask.

### .env keys (revised)

```
NAV_HOST=sql-grus-prd-01.database.windows.net
NAV_DATABASE=sqldb-nav18-grus-prd-01
NAV_PORT=1433
NAV_ENCRYPT=true
# Entra auth (drop NAV_USER / NAV_PASSWORD):
NAV_AUTH_MODE=aad-default        # local dev via az login
# Deployed service principal (only when not using a managed identity):
NAV_AAD_TENANT_ID=
NAV_AAD_CLIENT_ID=
NAV_AAD_CLIENT_SECRET=
```

### Company prefix: GRUS (and the DB is multi-company)

The NAV DB hosts multiple companies: `CHILE$`, `GAGE$`, `GRAM$`, `GRPROP$`, `GRUS$`, `PORTUGAL$`. Grundens US is `GRUS`. Every table MUST carry the `GRUS$` prefix, or you will read another company's data (or nothing).

Confirmed to exist, with the columns the design relies on:

- `[GRUS$Sales Header]` has `WebId` (nvarchar), `WebOrder` (tinyint), `WebSite` (nvarchar), plus `No_`, `Sell-to Customer No_`, `Order Date`.
- `[GRUS$Sales Header Staging]` (the stuck-staging `Status` source).
- `[GRUS$Sales Shipment Header]` (posted 3PL shipments; carrier / tracking / posting date).
- `[GRUS$Job Queue Log Entry]` has `Entry No_` (int), `Object ID to Run` (int), `Status` (int), `Start Date_Time`, `End Date_Time`. `Status` is an option: **0 = Success, 1 = In Process, 2 = Error** (confirmed live: Status 0 has thousands of rows completing continuously, Status 2 only a dozen last seen in 2022). A completed run is `Status = 0`. In-process rows carry the `1753-01-01` sentinel in `End Date_Time`; treat that as null.

The stub SQL in `navClient.ts` wrote several tables unprefixed (`[Sales Header]`, `[Job Queue Log Entry]`). Add the `GRUS$` prefix to every table. Example, the IABC watermark:

```sql
SELECT MAX([Entry No_])
FROM [GRUS$Job Queue Log Entry]
WHERE [Object ID to Run] = 50007 AND [Status] = 0;   -- newest CU 50007 (IABC) completion
```

### Likely resolution for BA open question 1 (orphan vs wholesale)

`[GRUS$Sales Header]` has a `WebOrder` (tinyint) column next to `WebId`. That is almost certainly the disambiguator:

- `WebOrder = 1` and empty `WebId` => a genuine DTC orphan (a web order that lost its correlation) => grade RED.
- `WebOrder = 0` => not a web order (wholesale / manual entry) => never an orphan.

Confirm with Mari before flipping `ORDER_ORPHAN_GRADING_ENABLED`, but this is the field that should gate it.

## 2. Middleware HTTP endpoints (separate source, still needed)

The NAV SQL box does NOT contain the middleware's own state. Read that from the middleware's existing read-only HTTP endpoints (as an external consumer, per design.md section 0):

- `MIDDLEWARE_BASE_URL` is the middleware VM host. Per the integration map that is `middleware.grundens.com` (Cloudflare-fronted). Confirm the exact base URL and network reachability with DevOps.
- The `dashboard.rs` read endpoints are unauthenticated observability surfaces (the middleware code notes "no auth / password gates because these are observability surfaces"). So `MIDDLEWARE_AUTH_TOKEN` is probably not required. Confirm reachability rather than assuming a token.

## Build order

NAV is the unblocked source now (server, database, prefix, and Entra auth are all known; local dev works via `az login`). Build the real read-only NAV client first, validate against `sqldb-nav18-grus-prd-01`, then wire the middleware HTTP client once DevOps confirms the base URL.

## Provisioning ask (for DevOps / Steve)

Grant the dashboard a read-only Entra identity (managed identity or service principal) with `db_datareader` on `sqldb-nav18-grus-prd-01` on server `sql-grus-prd-01.database.windows.net`. That single grant unblocks all NAV-sourced signals.

## 3. OOS-held detection + NAV-conditioned remediation routing (WI1 #87, WI2 #88, WI3 #89)

These three signals were added after the 2026-07-17 incident (a limited-edition drop, style `50625-425`, stocked only at Holman / `HF1FTZ`, stranded ~173 DTC orders in the middleware `oos_held_order` queue while the catalog inventory-sync pipe stayed green). All three reads are READ-ONLY; remediation stays behind `REMEDIATION_LIVE_ENABLED`.

### 3.1 `oos_held_order` row schema (WI1) - middleware read

`GET /api/oos-held?limit=300` returns the OOS-held backlog. One row (`OosHeldOrderRow`), mapped by `mapOosHeldOrder` into the shared `OosHeldOrder`:

| Wire field | Meaning |
|---|---|
| `order_id` | Shopify numeric order id (kept as a string) |
| `order_name` | e.g. `SP-322348` |
| `class` | `transient` (a momentary allocator miss, the ALERTING population) or `backorder` (a genuine warehouse short, legitimate, NEVER drives red). Renamed `held_class` in the type (`class` is reserved). |
| `status` | `pending` \| `resolved` \| `needs_operator` |
| `attempts` | retry count |
| `first_seen_at` | when the order was first held (drives the age band) |
| `last_attempt_at` | last retry time |
| `last_detail` | the last retry outcome, human text (the dropped style/SKU is parsed from here) |

Grading (`aggregator/oosHeld.ts`, thresholds in `config.ts` `oosHeld`): depth bands the count of alerting rows (transient, not resolved); age bands the oldest `needs_operator` row. `backorder`-class rows never enter either count, so they can never drive red. An unread source (null) reads `unknown`, never a false green; an empty array is a genuine green (zero held).

### 3.2 FS-location availability divergence source (WI2) - data-source decision + PROXY caveat

WI2 compares NAV availability at `HF1FTZ` against the middleware's fulfillment-service (FS) per-location availability, flagging SKUs NAV shows stocked (`Qty Available > 0`) but whose FS availability reads `<= 0`.

- **NAV side (clean):** `navClient.getInventoryAvailability()` filtered to `HF1FTZ`. This is the existing read-only item-ledger availability per `(sku, location)`. FOLLOW-UP: this read does NOT carry the IABC `Qty On Hand` or `Earliest Shipment Date` columns the brief references, so `nav_on_hand` / `earliest_shipment_date` are surfaced as null and the `Earliest Shipment Date <= today` filter is best-effort (a null ship date is treated as eligible). When the IABC channel table's ship-date column is wired, the detector will exclude future-dated stock. Tracked as a PR follow-up.
- **FS side (PROXY, documented):** `GET /api/nav/inventory-sync/fulfillment-service-info` via `getFulfillmentServiceInfo()`. This is the closest DOCUMENTED middleware per-location availability read (confirmed live in the brief). Its exact per-SKU availability field shape is UNCONFIRMED, so the mapper accepts the plausible aliases (`fs_available` / `available` / `fulfillment_service_available` / ...) and the detector marks `fs_source_is_proxy = true`. FOLLOW-UP: confirm the fulfillment-service-info per-SKU availability field with Symmetry, or wire a cleaner per-location read, then flip the proxy flag. No new endpoint was invented; a SKU the FS read does not report is skipped (never asserted as a divergence).

This signal is its OWN pipe (`fs_location_divergence`), SEPARATE from the catalog inventory-sync freshness/liveness pipe, which was green throughout the incident.

### 3.3 Forward-sync duplicate-skip rule (WI3) - the routing gotcha

The middleware's `orders_updated.rs` idempotency: `POST /api/forward-sync/replay` returns `DuplicateSkip` (a no-op) when allocations exist AND the order is ALREADY in NAV; it only falls through and re-stages when allocations exist but the order is NOT in NAV. So a blanket re-drive no-ops on most held orders.

WI3 joins each held order to NAV (`GRUS$Sales Header` presence by `[No_] LIKE order_name + '-%'`; the dropped SKU line in `GRUS$Sales Line`) and buckets it (`aggregator/oosHeld.ts` `routeHeldOrder`):

| Bucket | Condition | Routed tool |
|---|---|---|
| `not_in_nav` | no matching `GRUS$Sales Header` | `forward_sync_replay` (`POST /api/forward-sync/replay {shopify_order_id}`, un-gated) |
| `in_nav_line_missing` | header present, dropped SKU absent from `GRUS$Sales Line` | `oos_held_nav_line_add` (ops runbook: manual NAV line-add; NO middleware endpoint) |
| `in_nav_line_present` | header + line both present | `oos_held_stale_clear` (ops step: verify + clear the stale hold) |

`forward_sync_replay` is mapped ONLY to `not_in_nav`; the invariant is unit-tested (`oosHeld.test.ts` "duplicate-skip invariant"). The WI2 divergence root-cause fix is the native FS re-floor (`POST /api/nav/inventory-sync/fulfillment-service-floor` / `-floor-one` / `fulfillment-service-sweep`), wired as gated (`NAV_TOGGLE_PASSWORD`) `middleware_endpoint` tools with `dry_run` defaulting on server-side.
