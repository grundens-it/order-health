# Kickoff: Executable remediation Tier 1 (ADR-0010) - live path for existing middleware endpoints, disarmed by default

> Grundens PM seat, Session A. Claude Code executes on the operator's machine. Tier 1 only. Nothing is armed in production by this PR. Read-only NAV / middleware / Shopify observability is unchanged. No em dashes.

## 1. Reading order

1. `docs/architecture/adr/ADR-0010-executable-remediation-actor-mode.md` (the decision, the safety model, the tiers).
2. `backend/src/remediation/remediationClient.ts` (the fully-stubbed client to be given a live path).
3. `backend/src/remediation/registry.ts` (tools: which are `middleware_endpoint` vs `ops_runbook`; the gated flag).
4. `backend/src/api/remediation.ts` (the operator trigger route) and `backend/src/config.ts` (config accessors).

## 2. Goal

Give `remediationClient` a real live execution path for the tools that already map to the middleware's existing authenticated endpoints, gated behind `REMEDIATION_LIVE_ENABLED` (default false), with per-action operator confirmation, an append-only audit log, and a global kill switch. Disarmed behavior is byte-for-byte what it is today. Closes #70.

## 3. Safety mechanisms

- DISARMED by default. `REMEDIATION_LIVE_ENABLED=false` -> every trigger returns `would_trigger` with the exact call, no live HTTP. This PR does not arm anything in prod.
- Only `middleware_endpoint` tools get a live POST (to the middleware's EXISTING authenticated route, Authorization: Bearer `MIDDLEWARE_AUTH_TOKEN`; gated tools also send `NAV_TOGGLE_PASSWORD`). `ops_runbook` tools NEVER make a mutating call (they return the manual step; `fs_refloor` stays runbook until Tier 2).
- The aggregator path never triggers remediation (preserve the no-auto-fire invariant and its test).
- `stuck_staging_dedupe` deletes NAV staging rows: never part of a bulk action, requires an explicit per-order confirm, and if a rollback story is not clear, hold it OUT of the executable path (leave it disarmed) and surface that in the PR.
- Read-only NAV / middleware / Shopify reads are unchanged. Do not open the PR, do not push to main, do not merge. No commits on a verification failure. Confirm git identity before committing.

## 4. Issue tracking

Umbrella #69 (executable remediation, ADR-0010). This PR is Tier 1, #70; the final commit closes it. Do not touch #71 (Tier 2 runner, blocked), #72 (QA), #73 (Symmetry ask).

## 5. Pre-flight (git)

- Branch off `round-3/fs-ui` (the latest integration point, it has the fs classification + registry): `git switch -c exec-remediation/tier1 round-3/fs-ui`.
- Clean tree. Confirm the target files exist on the branch: `git ls-tree round-3/fs-ui backend/src/remediation/remediationClient.ts backend/src/remediation/registry.ts backend/src/api/remediation.ts backend/src/config.ts shared/src/index.ts frontend/src/components/RemediationModal.tsx`.

## 6. Implementation plan (commit-friendly order)

1. Docs (commit 1, Pattern 4): stage this kickoff plus ADR-0010.
2. `backend/src/config.ts`: `remediation.liveEnabled` (`REMEDIATION_LIVE_ENABLED`, default false), `remediation.killSwitch` (`REMEDIATION_KILL_SWITCH`, default false), `middleware.authToken` (`MIDDLEWARE_AUTH_TOKEN`), and keep `togglePassword` (`NAV_TOGGLE_PASSWORD`). Add all to `.env.example` (never a real value).
3. `shared/src/index.ts`: an audit-log entry type (at, toolId, subjectKind, subjectKey, params, outcome) and a `confirmed: boolean` on the trigger input.
4. `backend/src/remediation/remediationClient.ts`: behind `liveEnabled && !killSwitch`, for a `middleware_endpoint` tool, issue the real authenticated POST (auth header; gated tools add the password); on any failure return a typed error, never throw to the route. `ops_runbook` tools return the manual step and make NO call. Disarmed or kill-switched returns `would_trigger` exactly as now. Append every operator execution to the audit log.
5. `backend/src/api/remediation.ts`: require `confirmed: true` in the body before a live fire (else return the `would_trigger` preview); enforce the kill switch; record the audit entry; keep the operator-token gate.
6. `frontend/src/components/RemediationModal.tsx`: a two-step confirm, show the exact call (method/path/target/params) and require an explicit "Confirm and run" click before POSTing with `confirmed: true`. Disarmed still shows the `would_trigger` preview. Never a native confirm().
7. `backend/src/remediation/*.test.ts` (node:test): disarmed returns `would_trigger` and makes no call; kill switch forces disarmed; `confirmed:false` never fires; `ops_runbook` never mutates; the aggregator no-auto-fire invariant still holds.

## 7. Verification (in order)

From the repo root after each meaningful commit: `npm run typecheck`, then `npm test`. No lint/format script in this repo. Do not commit on a failure.

## 8. Commit pattern

Small commits in the section 6 order, each referencing #70; the final commit `Closes #70`.

## 9. Push, do not open the PR

`git push -u origin exec-remediation/tier1`. Stop. The operator opens the PR. Update `docs/rounds/order-health.round.json` and refresh `/grundens:visual-status` at the unit boundary.

## 10. What NOT to change

The aggregator or any read path; the Tier 2 runner (blocked, #71); the FS re-floor script; do not arm `REMEDIATION_LIVE_ENABLED` in any committed `.env`; do not weaken the no-auto-fire invariant.

## 11. Surface it, do not decide it

If the `stuck_staging_dedupe` rollback story is unclear, leave it out of the executable path (disarmed) and say so in the PR. If a middleware route's auth shape differs from the registry, surface it, do not guess.

## 12. Orchestration and paste-ready /goal

Run this through the orchestrate discipline: invoke `/grundens:grundens-orchestrate` first to load the round discipline, then paste the `/goal`. Tier 1 is a single coupled unit (the client, the route, the modal, and the tests share one contract), so it runs as one phased pass in a single context, not a fan-out; the Stop hook holds the session to this brief until #70 is done.

/goal Run Executable Remediation Tier 1 in grundens-it/order-health per docs/kickoffs/executable-remediation-tier1-kickoff.md (ADR-0010). Branch exec-remediation/tier1 off round-3/fs-ui. Give remediationClient a live execution path behind REMEDIATION_LIVE_ENABLED (default false) plus a REMEDIATION_KILL_SWITCH, for the tools already mapped to existing middleware endpoints: fire the middleware's authenticated POST (Authorization Bearer MIDDLEWARE_AUTH_TOKEN; gated tools add NAV_TOGGLE_PASSWORD); ops_runbook tools never mutate; disarmed or kill-switched returns would_trigger exactly as today. Add per-action confirm (require confirmed:true in api/remediation.ts and a two-step Confirm-and-run in RemediationModal showing the exact method/path/target/params) and an append-only audit log (shared type; recorded on every operator execution). Hold stuck_staging_dedupe out of any bulk action and, if its rollback story is unclear, leave it disarmed and surface that in the PR. Add the config keys to config.ts and .env.example with no real values. node:test: disarmed-returns-would_trigger and makes no call, kill switch forces disarmed, confirmed:false never fires, ops_runbook never mutates, and the aggregator no-auto-fire invariant still holds. Verify npm run typecheck then npm test after each commit. Update docs/rounds/order-health.round.json and refresh /grundens:visual-status at the unit boundary. Commit per step referencing #70 with the final commit closing it; push exec-remediation/tier1. Read-only NAV/middleware/Shopify observability is unchanged; do not arm REMEDIATION_LIVE_ENABLED in any committed env; do not build the Tier 2 runner (#71); do not open the PR or merge to main.
