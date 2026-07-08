# Kickoff: Unit 11 — forward_sync pipe (Shopify order exported but not in NAV)

> Grundens PM seat, Session A. Claude Code executes this on the operator's machine (it has `gh` and GitHub access; Cowork does not). Phase 1 only (NAV-staging-derived backlog, ADR-0006). No em dashes.

## 1. Reading order (read before writing)

1. `docs/architecture/forward-sync-pipe.md` (the design and the field mapping).
2. `docs/architecture/adr/ADR-0006-forward-sync-candidate-source.md` (NAV-staging-first, phase 1 vs phase 2, the config defaults).
3. `docs/business/forward-sync-requirements.md` (acceptance criteria US-1..US-10, the measured grace window).
4. `docs/business/forward-sync-test-plan.md` (the exact test cases) and `docs/business/ux/forward-sync-panel-spec.md` (the panel).
5. `docs/phase-w-adding-a-pipe.md` (the recipe) and `backend/src/aggregator/inventorySync.ts` (the reference pipe to copy).

## 2. Goal

Add the `forward_sync` pipe end to end, phase 1: a NAV-staging-derived backlog of Shopify DTC orders tagged exported that have no NAV Sales Order, with a two-verdict rollup (backlog freshness + export liveness), a panel, and the leadership-rollup fold-in. Read-only everywhere. Closes the Unit 11 sub-issue.

## 3. Safety mechanisms

- Read-only NAV (SELECT only, `GRUS$`-prefixed) and read-only middleware (phase-2 stub only). No Shopify token in this service. No new or modified middleware endpoint. No NAV writes.
- The only write is this service's own snapshot row.
- Do not open the PR. Do not push to `main`. Do not merge. No scope creep beyond the files in section 6.
- No commits on a verification failure. Confirm git identity before committing.

## 4. Issue tracking

Issues are already filed under umbrella #2: this unit is **#44** (phase 1, NAV-staging-derived); the never-staged tail is **#45** (phase 2, blocked on the middleware surface, do not build here). Every commit references #44; the final commit closes it with `Closes #44`. Leave #45 open.

## 5. Pre-flight (git)

- Branch off `main`: `git switch -c unit-11/forward-sync` (matches the `unit-<n>/<slug>` convention).
- Clean tree. Verify the target files exist on `main`: `git ls-tree origin/main backend/src/aggregator/inventorySync.ts backend/src/aggregator/writers.ts shared/src/index.ts backend/src/config.ts db/migrations/0001_init.sql`.
- Confirm `pipeline_health_snapshot.pipe` is free TEXT (it is, per `0001_init.sql`): no migration needed.

## 6. Implementation plan (commit-friendly order)

1. Docs (commit 1, Pattern 4 self-reference). Stage this kickoff plus the already-authored `forward-sync-pipe.md`, `ADR-0006-*`, `forward-sync-requirements.md`, `forward-sync-test-plan.md`, `forward-sync-panel-spec.md` if they are not yet committed.
2. `shared/src/index.ts`: add the `ForwardSyncDetail` interface (backlog_count, oldest_age_s, newest_age_s, last_success_at, contiguous_block, coverage: 'staging' | 'staging+tags', sample[]). No `PipeName` union exists; nothing else to add there.
3. `backend/src/sources/navClient.ts`: add read-only staging-derived methods (phase 1): a backlog-candidate read from `GRUS$Sales Header Staging` (candidate `Order Tags`, `CreatedDate` age clock, `Status`/`Error Message`, `Nav Order No`) plus the presence cross-check against `GRUS$Sales Header` and `GRUS$Sales Invoice Header` under `SP-<n>-%` (correlation on `<n>`; the `+'-'` extraction). Keep the documented SQL in comments; stubs return typed empties. Add the phase-2 `middlewareClient.getExportedPendingOrders()` seam as a stub only.
4. `backend/src/aggregator/forwardSync.ts`: the pure `computeForwardSync(input, thresholds, nowMs)` per the design (backlog filter, count-floored freshness, cycle-banded liveness, worstVerdict rollup, contiguous_block, coverage). Pure: no I/O, no `Date.now()`.
5. `backend/src/aggregator/writers.ts`: add `computeForwardSyncPipeline(sources)`, add `'forward_sync'` to the `PIPES` array, and include the seam in the `computePipelines` `Promise.all`. Map onto `PipelineHealth` per the Architect field mapping (freshness = backlog, liveness = export liveness, watermark_lag_s = oldest age, last_progress_at/heartbeat_at = last_success_at).
6. `backend/src/config.ts` and `backend/.env.example` (and root `.env.example`): add the `forwardSync` block with the ADR-0006 defaults (grace 30, backlog amber 30 / red 120 minutes, amber count 1 / red count 5, liveness amber 60 / red 180, date floor = NAV cutover date left blank with a comment). Never hardcode; read from env.
7. `backend/src/aggregator/forwardSync.test.ts` (node:test): all cases in the test plan section 3.
8. `frontend/src/components/ForwardSyncPanel.tsx` + mount under `PipelineStrip` in `frontend/src/App.tsx` + panel CSS in `frontend/src/styles.css`, per the UX spec (two `VerdictChip` cards, headline, oldest-first sample table, contiguous-block note, unknown-not-green, coverage label).

## 7. Verification (in order)

From the repo root, after each meaningful commit: `npm run typecheck`, then `npm test`. There is no `lint` or `format:check` script in this repo; if the operator wants them, that is a separate DevOps task. Do not commit on a failure.

## 8. Commit pattern

Small commits in the section 6 order, each message referencing the Unit 11 issue; the final commit closes it. Keep phase-2 stubs clearly commented as stubs.

## 9. Push, do not open the PR

`git push -u origin unit-11/forward-sync`. Stop. Do not open the PR; the operator opens it. Update `docs/rounds/order-health.round.json` with the Unit 11 entry and refresh `/grundens:visual-status` at the unit boundary.

## 10. What NOT to change

Other pipes, the migration, any live-source call, the middleware, the Shopify side. No new dependency (the staging read uses the existing `mssql` NAV client; the compute is pure TS).

## 11. Surface it, do not decide it

If anything is ambiguous (a tag string not in the config list, a staging column behaving unexpectedly, the date-floor value), surface it in the PR description and leave the safe default in place. Do not guess and bake it in.

## 12. Orchestration: fan-out plan (background agents)

Run this as a `/goal` round, not a linear pass. Decomposability check: after a small foundation, three slices are genuinely independent (disjoint files, sharing only the typed contract), so they fan out to background agents; the writer-seam wiring is the one coupled convergence step. Keep the main thread short; hand each agent a self-contained prompt and require a distilled 1,000 to 2,000 token return, not a transcript.

Phase F (foundation, main context, must land first):
- `shared/src/index.ts`: add `ForwardSyncDetail` (the contract all three agents import).
- `backend/src/config.ts` + `backend/.env.example`: the `forwardSync` block with the ADR-0006 defaults.

Phase W (fan-out, three independent background agents, after Phase F):
- Agent A (backend compute): `backend/src/aggregator/forwardSync.ts` (pure `computeForwardSync`) + `backend/src/aggregator/forwardSync.test.ts` (the test-plan cases). Imports the shared type only.
- Agent B (nav source): `backend/src/sources/navClient.ts` staging-derived read-only methods + the `middlewareClient` phase-2 stub. Disjoint from A and C.
- Agent C (frontend panel): `frontend/src/components/ForwardSyncPanel.tsx` + mount in `frontend/src/App.tsx` + panel CSS in `frontend/src/styles.css`. Imports the shared type only.

Phase C (convergence, main context, after the wave):
- `backend/src/aggregator/writers.ts`: `computeForwardSyncPipeline` + add `'forward_sync'` to `PIPES` + wire into `computePipelines` (needs A and B).
- Verify `npm run typecheck` then `npm test`. Update `docs/rounds/order-health.round.json`. Refresh `/grundens:visual-status`. Commit referencing #44 (final commit `Closes #44`). Push `unit-11/forward-sync`. Do not open the PR.

## 13. Paste-ready /goal

/goal Build Unit 11 (forward_sync pipe, phase 1) in grundens-it/order-health per docs/kickoffs/forward-sync-unit-11-kickoff.md. Issues are filed: #44 (this unit), #45 (phase 2, blocked, do not build). Branch unit-11/forward-sync off main and commit the authored forward-sync docs as commit 1. Land Phase F in this context (shared ForwardSyncDetail type; config forwardSync block with ADR-0006 defaults, grace 30, backlog amber 30 / red 120, count 1 / 5, liveness 60 / 180). Then fan out Phase W as three independent background agents, each a self-contained prompt with a distilled return: Agent A backend/src/aggregator/forwardSync.ts + forwardSync.test.ts; Agent B backend/src/sources/navClient.ts staging-derived read-only methods + middlewareClient phase-2 stub; Agent C frontend/src/components/ForwardSyncPanel.tsx + mount in App.tsx + styles.css. Then run Phase C in this context: wire writers.ts (computeForwardSyncPipeline, add forward_sync to PIPES and computePipelines), verify npm run typecheck then npm test, update docs/rounds/order-health.round.json, refresh /grundens:visual-status, commit referencing #44 with the final commit closing it, push unit-11/forward-sync. Read-only NAV, zero middleware changes, no Shopify token, no em dashes. Do not open the PR; do not merge to main.
