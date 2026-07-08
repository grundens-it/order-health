# ADR-0006: Source the forward_sync candidate set from NAV staging first, then the middleware tag surface for the never-staged tail

- Status: Draft (Architect seat, 2026-07-07). Flip to Accepted once Steve signs off.
- Deciders: Steve (operator), Architect seat.
- Companion: `docs/architecture/forward-sync-pipe.md`, `docs/business/forward-sync-requirements.md`. Locked-in: ADR-0001 (standalone read-only service), ADR-0002 (snapshot in this service's own store).

## Context

The `forward_sync` pipe (Unit 11) surfaces Shopify DTC orders the middleware tagged as exported that never created a NAV Sales Order. A stuck order is, by definition, absent from `GRUS$Sales Header` and `GRUS$Sales Invoice Header`. Absence has two sub-cases:

1. Reached NAV staging but was not promoted (present in `GRUS$Sales Header Staging` with no promoted order, or with an error).
2. Never reached NAV staging at all (the middleware handed off but the staging-write never happened), so the only system that knows is Shopify, via the order tag.

The candidate set is therefore fundamentally Shopify tag state, but a 2026-07-07 live read showed `GRUS$Sales Header Staging` is far more than a bare status table. It retains full history and carries `CreatedDate` (a real per-order age clock), `LastModifiedDate`, `Status`, `Nav Order No` (populated on promotion), `Error Message`, and an `Order Tags` snapshot of the Shopify tags (`1-Status:Shopify-Exported!`, `1-Middleware Status!`, `1-Status:NAV-Created!`). So NAV alone can already surface sub-case 1 with a real age and the tag, read-only, with no external dependency.

The tag list is confirmed from the middleware's `order_tags.rs`: candidate tags are `1-Status:Shopify-Exported!` and `1-Middleware Status!` (plus the legacy `1-Status:Middleware-Imported!`); `1-Status:NAV-Created!` is terminal and never a candidate.

## Decision

Source the pipe in two phases. Phase 1: derive the backlog from `GRUS$Sales Header Staging` read-only (orders present in staging with a candidate tag or unpromoted/errored status, absent from Sales Header and Sales Invoice Header under `SP-<n>-%`, older than the grace window), using `CreatedDate` as the age clock. Phase 2: add the middleware's existing read-only exported-tag surface to catch the never-staged tail (sub-case 2). No Shopify token is added to this service and no middleware endpoint is created.

## Alternatives considered

### Alternative A: Middleware tag surface only (the original spec)

Read the exported-tag set from the middleware's read-only order surface.

- Pros: catches the full condition, including never-staged orders.
- Cons: hard-blocked on a middleware read surface that may not exist yet. If it does not, nothing ships. It also depends on Symmetry-owned code and the VPN reachability, the pipe's single external gate.

### Alternative B: NAV staging only

Derive the backlog purely from `GRUS$Sales Header Staging`.

- Pros: fully read-only NAV, ships now with no external dependency, carries a real per-order age clock (`CreatedDate`) and the tag snapshot, and is what made the grace window measurable.
- Cons: misses sub-case 2 (orders that never reached staging), a real if rarer slice of the 2026-07-01 failure. The pipe would under-report until the tail is added.

### Alternative C: Two-phase, B now then A additively (recommended)

Ship the NAV-staging-derived backlog first, add the middleware tag surface for the never-staged tail when it is available.

- Pros: a meaningful, honest pipe ships immediately with zero external dependency and a real age clock; the harder tail is added without rework because both sources feed the same `computeForwardSync`. Degrades the ADR from a hard blocker to a second phase.
- Cons: v1 coverage is a documented subset (staging-reached only); the pipe must label its coverage honestly so a "green" is not misread as "no never-staged losses."

## Recommendation

Alternative C. The staging finding removes the need to block the whole pipe on a Symmetry coordination gate. Ship the NAV-staging backlog now (it has the age clock and the tags, and it caught the majority pattern: the 2026-07-01 block sat in this exact stalled state), and add the never-staged tail additively in phase 2. The pipe surfaces its own coverage ("staging-derived; never-staged tail pending source") so a green verdict is not over-read.

## Consequences

- `navClient` gains read-only staging-derived methods (backlog candidates + presence cross-check against Sales Header and Sales Invoice Header), all `GRUS$`-prefixed, SELECT-only. `middlewareClient.getExportedPendingOrders()` stays the phase-2 seam and remains stubbed until the surface is wired.
- Coverage labeling: `ForwardSyncDetail` carries a `coverage` note ("staging" in v1, "staging+tags" in v2) so the panel and the leadership rollup do not over-read a green.
- Config defaults (folded in from the 2026-07-07 measurement; Unit 11 sets these in `config.ts` and `.env.example`):
  - `FORWARD_SYNC_GRACE_MINUTES = 30` (was 15; data-derived: median staging-to-promotion about 9 min, CU 50009 promoter about every 5 min, worst cycle about 26 min).
  - `FORWARD_SYNC_BACKLOG_AMBER_MINUTES = 30`, `FORWARD_SYNC_BACKLOG_RED_MINUTES = 120`.
  - `FORWARD_SYNC_BACKLOG_AMBER_COUNT = 1`, `FORWARD_SYNC_BACKLOG_RED_COUNT = 5`.
  - `FORWARD_SYNC_LIVENESS_AMBER_MINUTES = 60`, `FORWARD_SYNC_LIVENESS_RED_MINUTES = 180`.
  - `FORWARD_SYNC_DATE_FLOOR` = the NAV cutover date (BA to supply; excludes the historical May cluster).
  - Liveness source: newest promotion observed in staging (`MAX(CreatedDate)` over recently promoted rows) is a better "last import" signal than `[Order Date]`; use it.
- DevOps seat: wire the staging reads (phase 1) now; provision the middleware read-only tag surface (phase 2) as a follow-on. No Shopify token, no middleware endpoint.
- QA seat: test the staging-derived boundaries and add an explicit coverage-caveat assertion (a green means "no staging-stalled backlog," not "no never-staged losses") until phase 2 lands.
- PM seat: Unit 11 ships phase 1; phase 2 is a follow-on sub-issue blocked on the middleware surface.

## References

- `docs/architecture/forward-sync-pipe.md` (section 3 finding), `docs/business/forward-sync-requirements.md` (grace-window measurement, open confirmation 1).
- Live NAV reads, 2026-07-07: `GRUS$Sales Header Staging` columns and the CU 50009 cadence.
- Middleware `order_tags.rs` (the authoritative tag constants).
