# Design + architecture review: `forward_sync` pipe (Shopify order exported but not in NAV)

> Architect seat, Session C (architecture review of the handoff spec `forward-sync-pipe-design.md`) resolving into a design. Status: Draft. Grounded in a read of the current code (`writers.ts`, `inventorySync.ts`, `shared/src/index.ts`, `0001_init.sql`, `phase-w-adding-a-pipe.md`) and a live read-only validation against NAV (`sql-grus-prd-01` / `sqldb-nav18-grus-prd-01`).
> No em dashes. Read-only everywhere. This doc decides; PM/DevOps/QA/UX implement.

## Verification (pre-draft)

- Highest ADR: 0005. This pipe is a design-doc-level addition following the `phase-w-adding-a-pipe.md` recipe; it needs no new ADR by itself. The one real decision it contains (the candidate-set source, section 3) should be ratified as ADR-0006 once DevOps confirms the middleware read surface.
- Locked-in decisions checked: ADR-0001 (standalone read-only service), ADR-0002 (materialized snapshot in this service's own store), the read-only-everywhere charter, and the first-class channel dimension. No conflict, subject to the section 3 boundary rule.
- Schema state: `pipeline_health_snapshot.pipe` is `TEXT NOT NULL` with NO check/enum constraint (`0001_init.sql`). Adding `forward_sync` needs NO migration.

## 1. Restatement (one paragraph)

Add a seventh observability pipe, `forward_sync`, that surfaces the production failure of 2026-07-01: Shopify DTC orders the middleware tagged as exported (`1-Status:Shopify-Exported!` or `1-Middleware Status!`) whose NAV Sales Order create never committed, so they exist nowhere in NAV and were only found by manual inspection. The pipe reads the exported-tag candidate set (via the middleware's read-only surface) and NAV presence (read-only), grades a backlog freshness verdict and an export-liveness verdict, rolls them up with `worstVerdict`, writes only this service's own snapshot row, and points operators at the existing manual recovery path. It never re-drives the export.

## 2. What is correct in the spec

The handoff spec is strong and largely lands. Confirmed correct against the code and live NAV:

- The seven-step recipe mapping is right: pure compute module + writer seam + shared detail type + config block + `node:test` + panel, modelled on `inventory_sync`. This matches `phase-w-adding-a-pipe.md` exactly.
- The correlation semantics are validated against live data. A Shopify order `SP-<n>` becomes one or more NAV orders `SP-<n>-<leg>`. Confirmed: `GRUS$Sales Header.[No_]` holds `SP-320319-1`, and multi-leg orders exist (`SP-320308-2`). Correlation on `<n>`, never the leg, is correct and necessary.
- The dual-table presence check is correct. `GRUS$Sales Header.[No_]` (open) and `GRUS$Sales Invoice Header.[Order No_]` (posted) both exist. Live shapes differ: open orders carry the leg (`SP-320319-1`), posted invoices appear as the bare `SP-<n>` (`SP-99999`). The spec's `CHARINDEX('-', No_ + '-', 4)` handles both, verified: it extracts `320319` from `SP-320319-1` and `99999` from `SP-99999`.
- `GRUS$Sales Header Archive.[No_]` exists, so the optional archive completeness check is buildable.
- The amber/red band model, the count-floor ("a real stuck order is never GREEN"), the grace window, and the `dateFloorIso` cutover exclusion are all sound and match how the sibling pipes band their verdicts.
- The read-only boundary and the non-auto, link-only remediation are correct and consistent with the repo charter and the `noAutoTrigger` invariant.

## 3. The one decision: candidate-set source (ratify as ADR-0006)

A stuck order is absent from NAV by definition, so NAV cannot produce the candidate set; it can only confirm presence. The candidate set is Shopify tag state.

- Alternative A (recommended): read the exported-tag set from the middleware's existing read-only order surface. No new Shopify token in this service, no middleware change if the surface exists.
- Alternative B: derive the candidate set from NAV `GRUS$Sales Header Staging` alone. Pure NAV read-only, but it cannot see orders that never reached staging, which is exactly this failure, and it overlaps the existing `nav_staging` order-stage signal.

Recommendation: Alternative A. Hard rule: this service adds no Shopify token and no middleware endpoint (Symmetry-owned). If the read surface does not yet exist, that is a DevOps/Symmetry coordination gate and the source ships stubbed (returns `[]`, typed) like every other pipe until wired. Ratify as ADR-0006 when the surface is confirmed. This is the pipe's single blocking dependency and its main risk; call it out to Mari/DevOps first.

Finding (2026-07-07, live NAV): `GRUS$Sales Header Staging` is a stronger NAV-only source than the spec assumed. It retains full history and carries `CreatedDate` (a real age clock), `LastModifiedDate`, `Status`, `Nav Order No` (the promoted order number, populated on success), `Error Message`, and an `Order Tags` snapshot of the Shopify tags. So NAV alone can already surface the "reached staging but not promoted / errored" subset with a real per-order age and the tag, no Shopify surface required. Alternative A is still needed for the tail that matters most (orders tagged exported that never even reached staging, absent from staging too), but this means the pipe can ship a meaningful NAV-only v1 (staging-derived backlog) and add the never-reached-staging tail when the middleware surface lands. It also gives the order age clock (`CreatedDate`) directly, and it is what made the grace window measurable (see the BA doc): median staging-to-promotion about 9 minutes, CU 50009 promoter running about every 5 minutes, worst cycle about 26 minutes, so grace 30 minutes.

## 4. Corrections and concrete deltas (fold into the builder handoff)

1. No migration. `pipeline_health_snapshot.pipe` is free `TEXT`; do not add a CHECK/enum migration. The spec's conditional in its Step 3 resolves to "no migration needed."
2. No `PipeName` union exists. The canonical pipe-id list is the `PIPES` const in `backend/src/aggregator/writers.ts`. Add `'forward_sync'` there (append, keep strip order additive). There is nothing to add in `shared` except the new detail interface.
3. No `placeholderPipe('forward_sync')` exists today. Do not "replace" it. Instead add `computeForwardSyncPipeline(sources)` and include it in the `landed` `Promise.all([...])` inside `computePipelines`. The `PIPES.map(... ?? placeholderPipe(p))` fallback then covers it automatically before the seam lands.
4. Specify the `PipelineHealth` column mapping (the spec leaves it implicit). Map the pure result onto the existing row shape as:
   - `pipe`: `'forward_sync'`
   - `freshness_verdict`: the backlog verdict (exported-not-in-NAV staleness)
   - `watermark_lag_s`: `oldest_age_s` (oldest stuck backlog age, seconds)
   - `last_progress_at`: `last_success_at`
   - `liveness_verdict`: the export-liveness verdict
   - `heartbeat_at`: `last_success_at`; `heartbeat_age_s`: age of `last_success_at`
   - `pipe_verdict`: `worstVerdict([backlogVerdict, livenessVerdict])`
   - `detail`: the `ForwardSyncDetail` bag
   This reuses the two existing verdict columns as the panel's two chips ("Backlog" = freshness, "Export liveness" = liveness), so the `PipelineStrip` renders it with zero shape changes.
5. `worstVerdict` severity is green(0) < unknown(1) < amber(2) < red(3). Consequence for the stub: empty candidate set gives backlog GREEN and liveness `unknown` (no `last_success_at`), so the pipe reads `unknown`, consistent with the other un-provisioned pipes. Correct, no change needed, but state it so the builder does not "fix" it.
6. Liveness source is questionable. `MAX([Order Date])` measures the newest present order's order date, not when the last import happened, so it lags oddly during a stall. Before building, check `GRUS$Sales Header` for the NAV18/BC system audit column `[SystemCreatedAt]` (or `[SystemModifiedAt]`); if present, `MAX([SystemCreatedAt]) WHERE No_ LIKE 'SP-%'` is the true "last import committed" time and the correct liveness source. If it is absent, keep `[Order Date]` as a documented approximation. This is BA/DevOps open question, do not guess.

## 5. Risks the spec does not fully address

- Candidate-set source (section 3) is the gating risk. Without the middleware read surface the pipe cannot see the exact orders it exists to catch. Resolve first.
- Grace vs the real stall duration. `graceMinutes` default 15 with `backlogAmberMinutes` 30 assumes imports normally commit within minutes. Confirm the normal import latency with Mari so the grace window does not either hide a real 20-minute stall or cry wolf on normal lag.
- `dateFloorIso` default. If left empty the historical May cutover cluster (`SP-311050..`) and stale 2024-2025 tag lint re-enter the backlog and the pipe boots RED on day one. Default the floor to the current NAV cutover date (config), and make Ops able to widen it.
- Tag drift. The tag names (`1-Status:Shopify-Exported!`, `1-Middleware Status!`) are middleware-owned strings. If the middleware renames a stage tag, the candidate query silently returns fewer rows and the pipe goes falsely green. Keep the tag list in config, and add a QA check that a nonempty candidate set is observed at least sometimes (a "source liveness" guard), so a silent zero is distinguishable from a healthy zero.
- Invoice `[Order No_]` shape. Live posted invoices show the bare `SP-<n>`. If any historical invoice ever carries a leg, the extraction still works, but the presence union should not assume leg presence on the invoice side. The spec's `+'-'` handles it; keep it.

## 6. The pipe as designed (the resolved spec)

Everything in the handoff spec's sections 1, 2, 4 stands, amended by section 4 above. Concretely:

- Sources (read-only stubs, DevOps-gated): `middlewareClient.getExportedPendingOrders()` returns the typed candidate set from the middleware read surface (section 3); `navClient.getNavPresentShopifyNumbers(numbers)` and `navClient.getLastForwardSyncSuccessAt()` return NAV presence and the liveness timestamp. All `GRUS$`-prefixed, SELECT-only, with the documented SQL in comments.
- Pure compute `backend/src/aggregator/forwardSync.ts`: `computeForwardSync(input, thresholds, nowMs)` returns `{ freshnessVerdict, livenessVerdict, pipeVerdict, detail }`. Backlog filter = exported minus `navPresent` minus younger-than-grace minus before-`dateFloorIso`. Freshness escalates by the worse of the age band and the count band, floored at AMBER once count >= 1 past grace. Liveness cycle-bands the age of `last_success_at`, `null` => `unknown`. `pipeVerdict = worstVerdict([...])`. Detail carries `backlog_count`, `oldest_age_s`, `newest_age_s`, `last_success_at`, `contiguous_block`, and a capped oldest-first `sample`.
- Shared detail `ForwardSyncDetail` added to `shared/src/index.ts` (the spec's shape is good).
- Writer seam + `PIPES` add per section 4 deltas.
- Config `forwardSync` block + `.env.example` per the spec's table.
- `contiguous_block` fingerprint: true when >= `backlogRedCount` backlog orders cluster in one tight created-at window, the "export stalled for a window" signature from the 2026-07-01 incident (`SP-319121..SP-319156`).

## 7. Seat handoffs

- BA seat: confirm with Mari the normal import latency (grace/amber bands), the `dateFloorIso` cutover default, the authoritative tag list, and whether `[SystemCreatedAt]` exists for the liveness source. Own the acceptance criteria (the spec's Step 6 test list is a good base).
- DevOps seat: resolve section 3, provision the middleware read-only order/tag surface (or confirm the existing one), and wire the three stubbed source methods behind their interfaces. No Shopify token in this service, no middleware endpoint.
- QA seat: the spec's Step 6 boundary tests plus two additions from section 5: a source-liveness guard (a silent zero candidate set is distinguishable from a healthy zero) and the multi-leg presence invariant (an `SP-<n>-2`-only order still counts `<n>` as present).
- UX seat: the two-chip `ForwardSyncPanel` (Export liveness, Backlog), shape-encoded via `VerdictChip`, the headline line, the oldest-first sample table, and the "stalled window detected" note on `contiguous_block`. Dark-theme tokens, mounts under `PipelineStrip`.
- PM seat: add this as a new Phase W unit (Unit 11), one PR closing its sub-issue, update the round-state, refresh `/grundens:visual-status`. Blocked-by: the ADR-0006 candidate-set decision.

## 8. References

- Handoff spec: `forward-sync-pipe-design.md`.
- Recipe: `docs/phase-w-adding-a-pipe.md`. Reference pipe: `backend/src/aggregator/inventorySync.ts`.
- Contracts: `shared/src/index.ts` (`Verdict`, `worstVerdict`, `PipelineHealth`), `db/migrations/0001_init.sql` (pipe is free TEXT).
- Data facts: `docs/DATA_SOURCES.md`, and this session's live reads (`GRUS$Sales Header`, `GRUS$Sales Invoice Header`, `GRUS$Sales Header Archive`, extraction verified).
- Locked-in: ADR-0001, ADR-0002. New decision to ratify: ADR-0006 (candidate-set source).
