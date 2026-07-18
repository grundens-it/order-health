# Round 3 result: FS-aware classification, remediation, and the "why" UI

> Phase C verification. Ran the real order-layer compute against live read-only NAV +
> live read-only Shopify (remediation untouched / disarmed). Read-only everywhere; no
> writes beyond this service's own snapshot. No em dashes.

## What the round fixed

The integration build correctly flagged the awaiting_ship stalls but could not say WHY,
mis-ingested Happy Returns as orders, and its click-through and leadership cards
explained nothing. Round 3 closes all of it.

## Live confirmation (real NAV + live Shopify)

- FS-aware classification (Unit 1): of the 34 awaiting_ship RED orders, 32 classify
  `fs_floor_at_zero` (the Shopify Fulfillment Service location holds a NEGATIVE
  available, e.g. -1, while the NAV warehouse is stocked, e.g. 507 / 341 / 300); the
  other 2 are `genuine_3pl_delay` (in stock, FS available >= 0). This is the Symmetry
  floor-at-zero bug, now named, with the FS and warehouse numbers carried on the order.
- Happy Returns (Unit 2): the 8 Document Type 5 (HR-) records are reclassified as
  `return` and excluded from awaiting_ship grading; 0 are graded a stall.
- The FS-location read resolves the "Grundens Fulfillment Service" location BY NAME
  (it is hidden from Shopify `locations()`), never a hardcoded id, and chunks the read
  by 100 (the productVariants cap) so every red order's SKUs are covered.

## Remediation + UI (Unit 3, 4, 5)

- `fs_floor_at_zero` maps to an FS re-floor ops_runbook (ADR-0003), NOT
  back_sync/submit_fulfillment: a fulfillment cannot fix a floored location. The three
  findings are closed: the nav_staging_stuck "Not Auto-released" gap (new
  rerun_auto_release, now primary), the close_unfulfilled_fos targeting/safety review,
  and webhook_resubscribe reconciled with the outcome signal (a new outcome-redrive).
- Clicking any red/amber item (pipe or order) now renders a "Why this is red/amber"
  block FIRST, built from the subject's verdict + detail (order: stage + age + the FS
  classification with numbers), with a plain next-step note when no tool is mapped.
- Every leadership rollup card is a keyboard-focusable `<button>` drill-through (orders
  card to the filtered order table, oldest-stuck to the offending order's why, the
  inventory card to its panel).

## Verification posture

The data-level claims (FS classification, returns exclusion) are LIVE-confirmed against
real NAV + Shopify. The UI claims (why-first modal, card drill-through) are verified by
typecheck and code review; there is no headless browser in this environment. All pure
computes are covered by node:test (267 tests green), remediation stayed disarmed, and no
NAV / middleware / Shopify write was made.

## Orchestration note

Unit 5 (LeadershipStrip drill-through) ran as a background worktree agent in parallel
with Units 3 and 4 in the main context. The other units share the order ingest (F) or
the RemediationModal / App.tsx integration surface, so they were sequential by coupling,
not by choice.
