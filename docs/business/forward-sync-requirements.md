# Requirements: `forward_sync` pipe (Shopify order exported but not in NAV)

> Grundens BA seat, Session B (feature requirements doc). Status: Draft. Companion to `docs/architecture/forward-sync-pipe.md` (Architect) and `forward-sync-panel-spec.md` (UX). No em dashes.
> Locked-in-decision check: read ADR-0001 (standalone read-only service), ADR-0002 (snapshot in this service's own store), and the read-only-everywhere charter. No conflict found, conditional on the candidate-set source staying the middleware's existing read-only surface (Architect ADR-0006).

## 1. Feature summary and value

When the Shopify to NAV order export stalls, DTC orders keep an "exported / pending" tag but no NAV Sales Order is ever created, so they exist nowhere in NAV. On 2026-07-01 a contiguous block of about 36 orders (`SP-319121..SP-319156`) plus scattered singletons were lost this way and found only by manual inspection. This feature makes that condition a first-class, alerting health verdict on the Order Health dashboard so Ops catches it in minutes instead of by accident.

## 2. Scope

In scope: read-only detection of exported-but-absent orders, a two-verdict pipe (backlog freshness and export liveness), the panel, the leadership-rollup fold-in, and a link-only pointer to the existing recovery path.

Out of scope: re-driving or replaying the export (stays a human action in the middleware UI and the `Recover-StuckOrders.ps1` runbook); any Shopify API token in this service; any new or modified middleware endpoint.

Deferred: the optional `GRUS$Sales Header Archive` completeness check (catches created-then-deleted); alerting delivery (rides the existing `health_transition` hook, no new notifier here).

## 3. Roles

- Ops operator: the primary user; watches the pipe, works the backlog, triggers recovery manually.
- Leadership: sees the rolled-up headline verdict only.
- On-call / engineering: uses the same panel during an incident.

## 4. User stories and acceptance criteria

Verdict bands referenced below are config, owned by Ops (section 6). Acceptance criteria are written against seeded inputs so QA can verify them without a live source.

### US-1: Detect exported-but-absent orders
As an Ops operator, I want a health verdict when Shopify orders are exported but never created in NAV, so that lost orders are caught in minutes instead of by manual inspection.

- Given an order carries an exported/pending tag, has no NAV document under `SP-<n>-%`, and is older than the grace window, when the aggregator runs, then the order is counted in the backlog and the backlog (freshness) verdict is at least AMBER.
- Given a multi-leg order where only `SP-<n>-2` exists in NAV, when presence is evaluated, then the order counts as present (correlation is on `<n>`, never the leg) and is not in the backlog.
- Given an order present in `GRUS$Sales Invoice Header.[Order No_]` as the bare `SP-<n>`, when presence is evaluated, then it counts as present.

### US-2: Suppress in-flight orders (grace window)
As an Ops operator, I want orders still within the normal import window ignored, so that I am not alerted on orders that are simply in flight.

- Given an exported order younger than `graceMinutes`, when the aggregator runs, then it is excluded from the backlog and does not affect the verdict.
- Given an exported order exactly at or past `graceMinutes` and still absent from NAV, when the aggregator runs, then it enters the backlog and the verdict is at least AMBER (a real stuck order is never GREEN).

### US-3: Escalate a real backlog
As an Ops operator, I want the verdict to escalate with the size and age of the backlog, so that a systemic stall reads worse than a single straggler.

- Given the oldest backlog order is at or past `backlogRedMinutes`, when the aggregator runs, then the backlog verdict is RED even at count 1.
- Given the backlog count is at or past `backlogRedCount`, when the aggregator runs, then the backlog verdict is RED even when every order is young.
- Given a backlog with count at or past `backlogAmberCount` but below the red bands, then the verdict is AMBER.

### US-4: Recognize a stalled window
As an Ops operator, I want a "stalled window detected" signal when a contiguous block is lost, so that I can tell a systemic export stall from scattered singletons.

- Given at least `backlogRedCount` backlog orders whose created-at times fall in one tight window, when the aggregator runs, then `contiguous_block` is true and the panel shows the stalled-window note.

### US-5: Work the backlog oldest-first
As an Ops operator, I want each backlog order listed oldest-first with its age and which tag it carries, so that I can act on the worst first.

- Given a nonempty backlog, when I open the panel, then I see an oldest-first sample (capped at about 25) with order name, age, and tag.

### US-6: Export liveness
As an Ops operator, I want to know when the export last succeeded, so that a total stall (nothing importing at all) is visible even before a backlog builds.

- Given the time since the last successful import is at or past `livenessRedMinutes`, then the liveness verdict is RED.
- Given that time is within the amber band, then AMBER; under the amber band, GREEN.
- Given the liveness source is not wired (null), then the liveness verdict is `unknown`, never RED.

### US-7: Distinguish a real zero from a blind source
As an Ops operator, I want a real "zero stuck" distinguished from an un-provisioned or blind source, so that a silent zero is never mistaken for healthy.

- Given the candidate-set source is stubbed or returns nothing because it is not wired, when the aggregator runs, then the pipe reads `unknown` (not GREEN) for the un-sourced verdict.
- Given the source is wired and legitimately returns zero exported-pending orders, then the backlog verdict is GREEN.

### US-8: Exclude historical cutover noise
As an Ops operator, I want pre-cutover historical orders excluded by default, so that the pipe does not boot RED on the May cutover cluster or stale tag lint.

- Given `dateFloorIso` is set, when the backlog is computed, then orders created before it are excluded.
- Given an order in the historical May cutover cluster (`SP-311050..SP-311133`), when the default floor is applied, then it is not in the backlog.

### US-9: Point to recovery, never auto-fix
As an Ops operator, I want the panel to point me at the existing manual recovery path, so that I remediate without this tool ever re-driving the export.

- Given a red or amber forward_sync verdict, when I open remediation, then I see a non-auto, link-only entry pointing at middleware Fulfillment Recovery (force forward-sync single, bulk replay by date window) and `Recover-StuckOrders.ps1`.
- Given any state, then no automatic remediation fires and this service issues no middleware mutation.

### US-10: Fold into the leadership rollup
As Leadership, I want forward_sync folded into the headline rollup, so that a lost-order stall shows at a glance.

- Given the forward_sync pipe is RED, when the rollup is computed, then the headline reflects "stuck" and the pipe counts as red in the pipe tallies.

## 5. Glossary additions

- Forward sync: the Shopify to NAV direction of order flow (order export and NAV Sales Order create), as opposed to back-sync (NAV shipment to Shopify fulfillment).
- Exported / pending: a Shopify order carrying `1-Status:Shopify-Exported!` or `1-Middleware Status!`, meaning the middleware handed it off but NAV import is not confirmed.
- Backlog: exported/pending orders that are absent from NAV and older than the grace window.
- Grace window: the minimum age (`graceMinutes`) before an absent exported order is counted as stuck; suppresses normal in-flight latency.
- Contiguous block: a cluster of backlog orders within one tight created-at window; the "export stalled for a window" fingerprint.
- Leg: the shipment-leg suffix on a NAV order number (`SP-<n>-1`, `SP-<n>-2`). Correlation is always on `<n>`, never the leg.

## 6. Open confirmations (for Mari / Ops, before build hardens the defaults)

Each is framed with a recommended default so the pipe can ship with a sensible band and Ops tunes it.

1. Grace window (`graceMinutes`). RESOLVED programmatically from NAV history (2026-07-07), no longer a guess. Recommended default 30 minutes. Method and evidence: `GRUS$Sales Header Staging` carries `CreatedDate` (when the middleware wrote the order into NAV) and the promotion is run by CU 50009 (`processPendingOrders`). Over 7,140 successfully-promoted orders in the last 30 days, the median staging-to-touch latency is about 9 minutes and 44 percent promote within 5 minutes (the upper tail of that metric is contaminated by later unrelated edits, so it is not used). The CU 50009 promoter runs about every 5 minutes, with the worst observed inter-run gap about 26 minutes over the last 3 days. End to end (Shopify to staging is about 17 seconds per the integration map, plus one promoter cycle) a normal order reaches NAV within single-digit minutes, at most about 26 minutes on a bad cycle. 30 minutes sits just above that worst-normal case, so false positives are near zero, while a real stall (the 2026-07-01 block sat for hours) still surfaces within half an hour. Conservative alternative: 45 minutes if Ops wants extra margin against an occasional slow cycle, at the cost of a slower catch. Re-measure if the CU 50009 cadence changes.
2. Backlog bands. Recommended: amber count 1, red count 5; amber age 30 min, red age 120 min. Confirm with Ops against how quickly a stall must escalate.
3. Liveness bands. Recommended: amber 60 min, red 180 min since last successful import. Confirm.
4. `dateFloorIso` default. Recommended: the current NAV/middleware cutover date. Provide that date so the historical May cluster is excluded by default.
5. Authoritative tag list. Confirm the exact tag strings (`1-Status:Shopify-Exported!`, `1-Middleware Status!`) and whether any other stall-stage tag belongs in the candidate set. Keep the list in config so a middleware rename is a config change, not a code change.
6. Liveness source column (Architect handoff). Confirm whether `GRUS$Sales Header` carries `[SystemCreatedAt]`; if so it is the correct "last import committed" source, better than `[Order Date]`.
7. Candidate-set source (Architect ADR-0006). Confirm the middleware exposes a read-only exported-orders-by-tag surface; this is the pipe's single blocking dependency.

## 7. Handoffs

- Architect seat: ADR-0006 (candidate-set source) and the liveness-column decision gate this feature; both are captured in `forward-sync-pipe.md`.
- UX seat: US-4, US-5, US-9 imply the panel; see `forward-sync-panel-spec.md`.
- QA seat: acceptance criteria above translate directly into the seeded boundary tests; add the source-liveness guard (US-7) and the multi-leg invariant (US-1).
- PM seat: this is Phase W Unit 11, blocked-by ADR-0006; one PR closing its sub-issue.
