# Test plan: forward_sync pipe (Unit 11)

> Grundens QA seat, Session A (feature test plan). Status: Draft. Companion to `docs/business/forward-sync-requirements.md` (acceptance criteria), `docs/architecture/forward-sync-pipe.md`, ADR-0006. No em dashes.
> Test-infrastructure verification: the backend test runner is `node:test` (`node --import tsx --test src/**/*.test.ts`; root `npm test` delegates to the backend workspace). There is NO `vitest.config.ts` or `playwright.config.ts` in this repo, and the frontend workspace has no test script. Plan target path `backend/src/aggregator/forwardSync.test.ts` matches the `src/**/*.test.ts` glob (co-located, like `inventorySync.test.ts`). Panel checks are manual (no automated frontend layer); see the coverage gap in section 5.

## 1. Scope

The `forward_sync` pipe compute and its panel. Covers the BA acceptance criteria US-1 through US-10 and the invariants in the design and ADR-0006 (phase 1: NAV-staging-derived backlog). Live-source wiring and the never-staged tail (phase 2) are out of scope here.

## 2. Test pyramid breakdown

- Unit (node:test), the bulk: every verdict boundary and invariant on the pure `computeForwardSync(input, thresholds, nowMs)`, seeded inputs and a fixed `NOW`, no I/O. This mirrors `inventorySync.test.ts` and is where the reference pipe proves its bands.
- Integration (node:test, light): the navClient presence/backlog SQL shape is validated by the read-only queries already run live (design section 2). A fixture test asserts the writer seam maps the pure result onto the `PipelineHealth` columns per the Architect field mapping.
- Manual: the `ForwardSyncPanel` accessibility and state rendering, because there is no automated frontend test layer in this repo.

## 3. Test cases

All unit cases live in `backend/src/aggregator/forwardSync.test.ts` (node:test). Thresholds fixture uses the ADR-0006 defaults (grace 30, amber age 30, red age 120, amber count 1, red count 5, liveness amber 60, red 180).

| # | Precondition (seeded input) | Action | Expected | Type |
|---|---|---|---|---|
| 1 | Source wired, zero exported-pending orders | compute | freshness GREEN; `detail.coverage = 'staging'` | unit |
| 2 | Candidate source not wired (unknown coverage) | compute | the un-sourced verdict is `unknown`, pipe not GREEN (US-7) | unit |
| 3 | 1 order absent from NAV, age just past grace (31 min), young | compute | freshness AMBER by the count floor, never GREEN (US-2, US-3) | unit |
| 4 | 1 order absent, age below grace (10 min) | compute | excluded from backlog, no verdict effect (US-2) | unit |
| 5 | 1 order absent, age >= 120 min | compute | freshness RED at count 1 (US-3) | unit |
| 6 | 5 orders absent, all young (past grace, under red-age) | compute | freshness RED by count band (US-3) | unit |
| 7 | 1 order absent, createdAt before `dateFloorIso` | compute | excluded (US-8) | unit |
| 8 | 1 order whose number is in `navPresent` | compute | excluded, happy path (US-1) | unit |
| 9 | Order `SP-<n>` with only `SP-<n>-2` present in `navPresent` | compute | counted present, not in backlog (correlation on `<n>`, US-1 invariant) | unit |
| 10a | `lastSuccessAt` null | compute | liveness `unknown`, never RED (US-6) | unit |
| 10b | `lastSuccessAt` within amber band (90 min) | compute | liveness AMBER (US-6) | unit |
| 10c | `lastSuccessAt` past red band (200 min) | compute | liveness RED (US-6) | unit |
| 11 | backlog GREEN, liveness RED | compute | `pipeVerdict = worstVerdict([...]) = red` (US-10) | unit |
| 12a | >= red-count backlog orders clustered in one tight created-at window | compute | `detail.contiguous_block = true` (US-4) | unit |
| 12b | red-count backlog orders spread across a wide window | compute | `contiguous_block = false` | unit |
| 13 | 40 backlog orders | compute | `detail.sample` is oldest-first and capped at about 25 (US-5) | unit |
| 14 | pure result for a red backlog | map via `computeForwardSyncPipeline` fixture | `freshness_verdict` = backlog, `liveness_verdict` = export liveness, `watermark_lag_s` = oldest age, `pipe` = 'forward_sync' (Architect mapping) | unit |
| 15 | phase-1 green result | compute | `detail.coverage = 'staging'` so a green is labeled "no staging-stalled backlog", not "no never-staged losses" (ADR-0006) | unit |

## 4. Test data and fixtures

- A factory `mkCandidate(name, ageMinutes, tag, createdAtOffset?)` producing a seeded backlog candidate row, and `mkThresholds(overrides?)` returning the ADR-0006 defaults.
- A fixed `NOW` constant (a stable ISO epoch) passed as `nowMs` so every age is deterministic.
- `navPresent` built as a `Set<string>` of Shopify numbers; include a multi-leg fixture (`SP-319241` present only via its `-2` leg) for case 9.
- No live NAV or middleware in any unit test (sources are stubbed / seeded).

## 5. Manual checks (no automated frontend layer)

Run against `ForwardSyncPanel` in the running frontend, documented as a manual script:

- Keyboard: tab reaches each actionable (red/amber) verdict card, focus ring is visible, Enter and Space open the remediation modal, focus returns on close.
- Color independence: with color removed (grayscale), both chips are still legible via shape (circle / rounded square / rotated diamond / dash) and text label.
- Unknown-not-green: with an un-provisioned source, both chips read "Unknown" and the headline shows "not yet provisioned"; no false green. This is the highest-value manual check.
- Table semantics: the sample table announces column headers with each row in a screen reader.
- Stalled-window note: appears only when `contiguous_block`, leads with an icon plus text (not color alone).

## 6. Coverage gap (handoff to DevOps)

There is no automated frontend or accessibility test layer in this repo (the frontend workspace has no test script, and there is no Playwright config). The panel accessibility commitments in the UX spec are therefore verified manually only. Recommend a DevOps decision on whether to add a frontend test runner (component or e2e) so the unknown-not-green state and keyboard activation become regression-protected. Tracked as a follow-up, not a Unit 11 blocker.

## 7. Out of scope

- Live-source integration tests (NAV and middleware are DevOps-gated; the pipe ships stubbed).
- The never-staged tail (ADR-0006 phase 2); its detection and its coverage-label transition to `staging+tags` get their own cases when that source lands.
- Performance and load (the compute is pure and O(candidates); not a concern at current volumes).

## 8. Handoffs

- BA seat: if any acceptance criterion proves ambiguous when the tests are written, return it for tightening.
- Architect seat: if a test exposes a mapping or coverage-label ambiguity, return to `forward-sync-pipe.md` / ADR-0006.
- DevOps seat: the frontend-test-layer decision in section 6.
- PM seat: these cases are Unit 11 deliverables; every one is a checkbox on the sub-issue.
