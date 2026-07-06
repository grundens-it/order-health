# Order Health Observability: design.md

> Status: Draft (Architect seat, 2026-07-02; revised 2026-07-05 for the standalone-project boundary). First architecture design doc for the `order-health` repo.
> Companion decisions: ADR-0001 (delivery vehicle: standalone read-only service), ADR-0002 (health read-model).
> Architect-seat note: this is the design doc for the Grundens `order-health` project, a standalone dashboard that is separate from the Symmetry-owned warehouse-splitter middleware. Where a middleware or NAV behavior is effectively locked (the Cloudflare WAF skip rule, the Cthulhu / NAV staging-table boundary, read-only NAV access), it is called out inline and treated as fixed and external.

## 0. Project boundary (read first)

The Order Health dashboard is its **own project in its own repo** (`grundens-it/order-health`). It is **not** part of, and does not modify, the Symmetry-owned warehouse-splitter middleware. The middleware is production code we do not own.

Consequences that run through this whole document:

- The dashboard reads the middleware's **existing** read-only HTTP endpoints and NAV **read-only**. It adds no code, endpoints, migrations, or tables to the middleware.
- The health aggregator and the snapshot store live in the **dashboard's own datastore** (ADR-0002), never in the middleware.
- Remediation actions (section 5A.4) invoke the middleware's **existing** authenticated endpoints or documented ops runbooks; they never add a mutation path to the middleware.
- Where a signal the dashboard needs is not already exposed read-only by the middleware, read it from NAV directly; only if unavoidable, raise a gated request for Symmetry to expose a read-only endpoint. Never assume a middleware change.

Throughout this document, phrases like "reuse `dashboard.rs`" mean **read its endpoints as an external consumer** and copy its read-view shape in the dashboard's own code, not edit it in place.

## 1. Purpose and scope

Build one observability surface that answers a single operator question at a glance: **is order and inventory flow healthy right now, and if not, which order or which pipe is unhealthy and why.**

In scope:

- **Order lifecycle health**, per order, across both channels: direct-to-consumer (Shopify-originated) and wholesale (NAV-originated, no Shopify web order behind it).
- **Pipeline / system health**: the freshness, liveness, and error rate of every cron, watcher, and sync loop that moves orders and inventory between Shopify, the middleware, and NAV 18.
- **Inventory flow health** alongside order flow, because the two share the same failure surface (NAV IABC recalc, the inventory-sync watermark, location mapping).

Explicitly out of scope for v1 (called out so the PM seat can defer, not drop):

- Alerting delivery (paging, email, Slack). We design the hooks in section 8 but do not build a notifier in v1.
- 3PL-internal state. Per the integration map, the middleware never talks to TAC or Holman directly. We observe what NAV reports back (`GRUS$Sales Shipment Header`), not the 3PL's own systems.
- Returns / RMA flow.

## 2. Current state and why it is insufficient

The middleware already has real observability primitives. They are scattered, per-pipeline, and none of them join the Shopify side to the NAV side into an order-centric view.

What exists today:

- `dashboard.rs` serves a Home tab that merge-sorts five timestamped tables into one activity feed and an errors feed: `inventory_sync`, `price_sync`, `nav_shipment_sync`, `shopify_webhook_event`, `shopify_event_log`. Good bones, but it is a flat event stream, not a per-order or per-pipe health rollup.
- Dedicated diagnostic endpoints already exist: NAV job-queue health (`/api/nav/job-queue/health`, the CU 50007 / CU 50009 trip-wire), missed shipments (`/api/back-sync/missed-shipments`), stuck NAV staging, and pending fulfillment. Each is its own Frontend tab. An operator has to know which tab to open before they know something is wrong.
- A read-only NAV SQL console (`/api/nav/query/*`) with curated templates. Powerful for investigation, useless for at-a-glance health.
- NAV-side codeunit instrumentation already exists (the operator's words: "viewers that instrument our code units inside of NAV"). Today its UI is not built for observability and does not connect to the Shopify side. We treat this instrumentation as a **data source to unify**, not something to rebuild.

The three concrete blind spots that Investigations part 1 (2026-07-01 to 2026-07-02) exposed, none of which is surfaced as a health signal today:

1. **Inventory-sync watermark freshness is invisible.** The sync is event-driven off NAV IABC completions (CU 50007) against a watermark (`inventory_sync.last_iabc_job_entry_no`). When the watcher died during the nftables outage (`Timed out in bb8`, ~2 to 5 PM), nothing told anyone auto-sync had stalled. The only reason it got caught was a manual investigation.
2. **The dry-run vs live-walk divergence has no live metric.** A 16:46 dry-run reported 7,245 of 12,218 variant-location pairs "would push," while live walks push 50 to 500 per cycle. That gap may be benign (different counting) or a real backlog. Today there is no panel that shows it, so it can only be found by hand.
3. **Watcher / cron liveness after an incident is not tracked.** After the outage, "did the inventory-sync watcher cleanly resume" required reading the journal. A heartbeat-age signal would have answered it instantly.

The gap is not "we have no data." It is "the data is per-pipe, Shopify and NAV are never joined, wholesale is invisible, and freshness/liveness are not first-class signals."

## 3. The order health model

Two layers, one page.

### 3.1 Order lifecycle (the horizontal axis)

Model each order as a march through canonical stages, with a health verdict at each hop. The stages differ slightly by channel.

DTC (Shopify-originated):

```
Shopify order  ->  allocator split  ->  NAV staging write  ->  NAV promotion  ->  3PL ship (NAV shipment)  ->  Shopify fulfillmentCreate (back-sync)
```

Wholesale (NAV-originated):

```
NAV order (no WebId)  ->  NAV promotion  ->  3PL ship (NAV shipment)  ->  [no Shopify back-sync leg]
```

At each hop the model records: did the handoff happen, how long has it been waiting, and is there an error latched on the row. A stage is GREEN (completed on time), AMBER (in flight but within SLO), or RED (errored, or past its SLO age). The order's overall verdict is the worst stage verdict.

### 3.2 Pipeline / system health (the vertical axis)

Independent of any single order, each moving part reports a freshness-and-liveness verdict:

- inventory-sync watcher: watermark age vs newest NAV IABC entry, last walk timestamp, last walk pushed/skipped/untracked counts, watcher heartbeat age.
- price-sync: same freshness shape.
- back-sync (NAV shipment -> Shopify fulfillment): watermark age, missed-shipment count in window.
- NAV job queue: CU 50009 auto-release firing recently, no job stuck > 30 min (the existing tripwire).
- Shopify webhook intake: last received per topic, subscription health (the WAF-removal failure mode from the integration map).
- allocator: recent allocation error rate.

A pipe going RED explains a cluster of orders going RED. Showing both layers on one page is what turns "47 orders are stuck" into "back-sync watcher is 6 hours stale, that is why."

## 4. Data sources and the correlation-key problem

| Signal domain | Source of truth | Access path (existing) |
|---|---|---|
| Shopify order + fulfillment state | Shopify Admin API | `malibus_shopifyapi_tooling`, webhook tables |
| Allocator split decision | middleware SQLite | `warehouse_allocation_log` |
| NAV staging + promotion | NAV 18 | tiberius read via `nav/*`, `stuck_staging` |
| NAV shipment (3PL shipped) | NAV 18 | `nav/back_sync`, `GRUS$Sales Shipment Header` |
| Back-sync to Shopify | middleware SQLite | `nav_shipment_sync` |
| Inventory / IABC | NAV 18 | `nav/inventory_sync`, IABC watermark |
| NAV codeunit instrumentation | NAV 18 (existing viewers) | to confirm: table/view names and schema |

The hard part is **joining Shopify to NAV**. For DTC the correlation key is `[WebId]` on the NAV Sales Header, set from the Shopify order. For wholesale there is no `WebId` (this is exactly the `back_sync.rs:552` case: "orphan or wholesale"). Consequences:

- The order-health read-model needs a **channel dimension** from the start. DTC orders correlate on `WebId`; wholesale orders are keyed on NAV order number and customer, and simply have no Shopify leg to grade.
- "Orphan" (a DTC order that lost its `WebId`) and "wholesale" (correctly has no `WebId`) look identical at the row level and must be disambiguated, or every wholesale order shows up as a false RED. This is an open question in section 9 and a required BA-seat clarification.

## 5. Signal catalog

The v1 signal set. Each is RED / AMBER / GREEN with an explicit source and threshold. Thresholds are proposals for the BA and Ops seats to ratify.

Order-lifecycle signals (per order):

- Stuck in NAV staging: row in `Sales Header Staging` not at `Status = 0` (promotion errored, often a `Blocked = 1` SKU). RED immediately.
- Awaiting promotion: staged but not yet promoted. AMBER under 30 min, RED after.
- Awaiting ship: promoted, no NAV shipment. AMBER within channel SLO, RED after.
- Missed back-sync: NAV shipment exists, no `shopify_fulfillment_id` in `nav_shipment_sync`. RED (this is the existing missed-shipments query, promoted to a health signal).
- Pending fulfillment: Shopify FulfillmentOrder still OPEN + UNSUBMITTED. AMBER, RED after age.
- Orphan correlation: DTC order with empty `WebId`. RED (needs wholesale disambiguation, section 9).

Pipeline / inventory signals (per pipe), including the part-1 blind spots:

- **Inventory-sync watermark age**: `newest NAV IABC entry_no` minus `last_iabc_job_entry_no`, plus wall-clock age of last walk. GREEN if within one IABC cycle (~2h), RED if stale. (Blind spot 1.)
- **Watcher heartbeat age**: time since the inventory-sync / back-sync watcher last logged a loop. RED if older than N cycles. (Blind spot 3.)
- **Dry-run divergence**: last dry-run "would push" count vs trailing live-walk push volume. Surface the number with an explainer; AMBER when the ratio exceeds a threshold, never auto-RED until section 9 resolves whether it is a real backlog. (Blind spot 2.)
- Walk outcome: last walk `processed / pushed / skipped / untracked_filtered`. A nonzero `untracked_filtered` is an onboarding signal (the "track quantity off" gotcha from part 1).
- NAV job-queue: existing CU 50009 firing + no stuck job (already computed, promote to the rollup).
- Webhook subscription health: any topic with zero deliveries in its expected window, or a removed subscription (the 19-consecutive-4xx WAF failure mode).

## 5A. Inventory Sync Monitor (the reference subsystem)

The inventory-sync monitor is not a seventh pipe bolted on beside the others. It is the **reference implementation of the whole two-layer model**, and it is called out as its own subsystem for three reasons: it is the pipe that failed silently in Investigations part 1, it is the only pipe whose health directly gates order flow (a stale allocator ATP holds new splits, per the `SP-319102` held-order case in the demo), and it is the pipe where "healthy cron" and "fresh data" are genuinely different questions. The demo proved out its shape; this section fixes that shape into the design.

### 5A.1 Why it is elevated

Part 1 showed the failure mode the flat pipeline view misses: NAV IABC (CU 50007) kept completing on schedule, so a naive "is the cron alive" check stayed green, yet auto-sync had stalled because the middleware watcher died (`Timed out in bb8`) during the nftables outage and did not advance its watermark. Cron-alive and data-fresh diverged. The monitor therefore reports **three independent verdicts**, and the pipe is RED if any one is RED:

1. **Watermark freshness** (is the data current): `newest NAV IABC entry_no` minus `last_iabc_job_entry_no`, plus wall-clock age of the last completed walk. This is the signal that would have caught the outage.
2. **Watcher liveness** (is the loop running): heartbeat age since the watcher last logged a poll. Cron-alive is necessary but not sufficient; this is the second half.
3. **Push-outcome sanity** (is it doing useful work): last walk `processed / pushed / skipped / untracked_filtered`, plus the dry-run vs live divergence.

### 5A.2 Read-model contract

The monitor is the first concrete consumer of the ADR-0002 snapshot. It contributes one `pipeline_health_snapshot` row keyed `pipe = 'inventory_sync'` with these fields, all sourced read-only from `nav/inventory_sync.rs` state and the NAV Job Queue Log:

- `watermark_entry_no`, `nav_newest_iabc_entry_no`, `watermark_lag` (derived), `last_walk_at`, `watermark_verdict`.
- `watcher_heartbeat_at`, `heartbeat_age`, `liveness_verdict`, `trigger_mode` (`job_queue`).
- `last_walk_processed / pushed / skipped / untracked_filtered`.
- `dryrun_would_push`, `dryrun_at`, `live_push_trailing` (trailing max of recent live walks), `divergence_verdict`.
- `pipe_verdict` = worst of the three sub-verdicts; `as_of`.

The Frontend panel renders exactly the three cards the demo showed (watermark and watcher; dry-run divergence with its explainer; the recent-walks bar chart plus table). Nothing in the panel fans out to NAV live; it reads the snapshot row, so freshness is self-disclosing via `as_of` and `heartbeat_age`.

### 5A.3 Divergence handling (the 7,245 question, encoded)

The dry-run divergence is deliberately **amber-capped, never auto-RED**. The demo froze this rule: surface `dryrun_would_push` against `live_push_trailing` with a plain-language explainer, flag AMBER when the ratio exceeds a threshold Ops sets, and never escalate to RED until open question 9.x (dry-run vs live accounting reconciliation) is resolved. This prevents a benign counting artifact (re-activations counted by the dry-run but not the live walk) from crying wolf, while still keeping the number in front of an operator.

### 5A.4 Remediation actions (the runbook, wired)

The demo added a runbook layer, and it belongs in the design because it is the difference between a monitor and a tool. Each inventory-sync RED maps to a named remediation surfaced next to the signal. These are **operator-triggered, never automatic in v1**, and every one already exists as a middleware or ops capability:

- Watcher liveness RED -> **atomic restart** of the middleware watcher (`systemctl restart grundens-middleware`, per `ATOMIC_RESTART_DEPLOYMENT.md`); it resumes from `last_iabc_job_entry_no`.
- Watermark stale but watcher alive, and NAV job queue serialized -> **clear the hung CU 50007 Job Queue Entry** (diagnosed via `job_queue_health`) so the queue de-serializes and CU 50009 resumes.
- Untracked-filtered nonzero on a new product -> **onboarding fix**: enable Track quantity on the variants (the part-1 "track quantity off" gotcha); this is a Shopify-admin action, surfaced as guidance not a button.
- Dry-run divergence -> **read-only reconcile audit** to classify the delta; no writes.

Each remediation records to the ADR-0002 `health_transition` audit as a resolution event, so the future notifier (section 8) can close an alert as well as open one. The two write-capable actions (watcher restart, clear NAV job) run through existing authenticated ops paths, not new dashboard mutation endpoints, preserving the read-only-dashboard posture of section 7.

### 5A.5 Consequences for the seats

The monitor is the first unit to build because it is self-contained, it is the highest-value catch, and it exercises every layer (snapshot write, three-verdict compute, panel, remediation, transition audit) end to end. It becomes the template the other pipes follow. DevOps owns the `pipeline_health_snapshot` inventory row and the two ops-path remediation triggers; UX owns the three-card panel and the amber-never-red divergence treatment; QA owns the staleness simulation (kill the watcher, assert the pipe goes RED while CU 50007 still completes); BA owns the divergence threshold and the reconciliation open question.

## 6. Proposed architecture

Consistent with ADR-0001 (standalone read-only service) and ADR-0002 (materialized health snapshot in the service's own store).

- A standalone **Order Health** app (its own frontend), a two-layer layout: a pipeline-health strip on top (one card per pipe, freshness/liveness verdict), an order-health table below with channel filter (DTC / wholesale / all), stage columns, and worst-stage verdict, deep-linking into the middleware's existing per-pipeline tabs and its SQL console for drill-down.
- A **health aggregator** in the service that computes the two-layer model. Per ADR-0002 it writes a periodic snapshot into the service's own datastore (`order_health_snapshot` + `pipeline_health_snapshot`) rather than fanning out on every page load. The read endpoints serve from the snapshot, so the page is fast and adds no per-viewer load on NAV or the middleware.
- **Consume, do not rebuild, and do not modify the middleware.** The aggregator reads the middleware's existing read-only endpoints (activity/errors, `job-queue/health`, `back-sync/missed-shipments`) and reads NAV read-only for the IABC watermark, watcher state, allocation and shipment detail the endpoints do not expose. Where the middleware already computes a verdict (job-queue health), the aggregator consumes it rather than recomputing.
- **Channel dimension is first-class** in the snapshot schema so wholesale is visible and never mis-graded as an orphan.
- A **leadership rollup**: because Ops and Leadership were both named as audiences, the top strip collapses into a small set of headline verdicts (orders healthy / at risk / stuck, oldest stuck age, inventory-sync fresh yes/no) suitable for a glance, with the operator detail below the fold.

## 7. What we deliberately keep fixed

- Read-only against NAV. The aggregator only reads NAV; all NAV writes remain the existing staging-write path.
- The staging-table boundary with Cthulhu / NAV is unchanged. Observability adds no new write path into NAV.
- Cloudflare WAF skip rule for `/webhooks/shopify/` stays; webhook subscription health is a signal, not a config we change here.

## 8. Alerting hooks (designed, not built)

To keep v1 visualization-only while not painting us into a corner: the snapshot writer is the natural evaluation point. Every time it recomputes a verdict, it already knows a signal transitioned GREEN/AMBER -> RED. v1 records that transition in a `health_transition` audit row. A future notifier (DevOps seat) tails that table and dispatches. No polling-the-UI, no second evaluation engine. This is the single hook we commit to in v1 so alerting is a later additive change, not a redesign.

## 9. Open questions and assumptions to confirm

1. **Orphan vs wholesale disambiguation.** What definitively marks a NAV order as wholesale rather than a DTC order that lost its `WebId`? (Customer type on `GRUS$Customer`? An order-source field? A NAV series code?) Required before the orphan signal can avoid false REDs. BA seat + Mari.
2. **NAV codeunit instrumentation schema.** The existing "viewers that instrument our code units" are named as a reusable source but their table/view names, columns, and retention are not yet confirmed in this repo. Needs a schema walk before the aggregator can read them.
3. **Elastic's role.** The only in-repo reference is "Penny / Elastic lookup against the customer master." Assumption: Elastic is a Penny-side customer-master search dependency, not a data plane we own or observe directly. Confirm whether any inventory or order state we care about lives in Elastic, or whether it is purely customer resolution.
4. **Wholesale channel identity in Shopify.** Wholesale/B2B in Shopify typically runs through companies / draft orders; confirm whether Grundens wholesale is Shopify-B2B (has some Shopify presence) or purely NAV-entered (no Shopify object at all). This decides whether wholesale has any Shopify leg to grade.
5. **SLO thresholds per stage and per channel.** The AMBER/RED ages in section 5 are proposals. Ops sets the real numbers.
6. **Leadership rollup metric set.** Which four or five headline numbers leadership actually wants. BA + the operator.

## 10. Seat handoffs

- **BA seat**: user stories and acceptance criteria for the Order Health tab; resolve open questions 1, 4, 5, 6; own the signal-to-threshold table as requirements.
- **UX seat**: screen spec for the two-layer tab, the leadership rollup strip, verdict color tokens (consume brand tokens; do not redefine), accessibility of the RED/AMBER/GREEN encoding (never color alone).
- **DevOps seat**: the `order_health_snapshot` / `pipeline_health_snapshot` / `health_transition` tables and migration, the snapshot-writer scheduling, and the future notifier that tails `health_transition`.
- **QA seat**: test plan for verdict correctness (each signal's GREEN/AMBER/RED boundaries), the wholesale-not-orphan case, and a freshness-staleness simulation (kill the watcher, assert the pipe goes RED).
- **PM seat**: sequence the above into a build round; the snapshot schema and the NAV instrumentation schema walk (open question 2) are the critical-path unblockers.

## 11. References

- Investigations part 1 session (2026-07-01 to 2026-07-02): inventory-sync watermark, dry-run divergence, watcher liveness after the nftables outage.
- `documentation/GRUNDENS_INTEGRATION_MAP.md`: boundary diagram, DTC pipeline chain, Cloudflare WAF failure mode, staging-table boundary.
- `middleware/Backend/src/dashboard.rs`: the five-table merge and existing read views.
- `middleware/Backend/src/nav/job_queue_health.rs`, `missed_shipments.rs`, `stuck_staging.rs`, `inventory_sync.rs`, `back_sync.rs`: existing per-pipe signals and the `WebId` / wholesale correlation note.
- ADR-0001, ADR-0002.
