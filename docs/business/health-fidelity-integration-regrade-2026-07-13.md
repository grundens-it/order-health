# End-to-end re-grade: health-fidelity integration (2026-07-13)

> Unit F. The gate that proves the round. Ran the EXACT aggregator compute path
> (`computePipelines` + `computeOrders` + `computeRollup`) against real read-only NAV,
> the real middleware client, and the live read-only Shopify client. Remediation
> untouched / disarmed. Read-only everywhere; no writes. No em dashes.

## Sources (all live)

- middleware: https://middleware.grundens.com (real reconciled-route client, unauthenticated observability GETs)
- NAV: sql-grus-prd-01 / sqldb-nav18-grus-prd-01, GRUS, Entra aad-default (az login), SELECT only
- Shopify: grundens.myshopify.com, Admin GraphQL, client_credentials token fetched successfully, query-only

## Before (2026-07-13 live run, pre-fix baseline) vs After (this integration branch)

| Pipe | Before | After | Correct now? |
|---|---|---|---|
| nav_job_queue | UNKNOWN (adopted middleware level "Stuck") | GREEN (computed from NAV: auto-release live, in-process CU 50007 = 0 from Job Queue Entry, pending-staging Status=0 = 1; middleware says Ok, kept as cross-check) | Yes |
| back_sync | AMBER (76m-old watermark, no new work) | GREEN (idle_no_traffic: hasWork=false, caught up) | Yes |
| inventory_sync | AMBER (124m liveness on a 1-cycle band) | AMBER (freshness + liveness GREEN; the AMBER is the amber-capped dry-run divergence sub-verdict, informational, never red) | Liveness fixed; the remaining amber is the designed cap |
| allocator | AMBER (22 OOS backlog / 200 decisions = 0.11) | GREEN (window failed_rate = 0.01; OOS-held backlog = 23 surfaced separately, not in the rate) | Yes |
| price_sync | UNKNOWN (disabled, all null) | GREEN neutral (applicability = disabled) | Yes |
| shopify_webhook | UNKNOWN (quiet topics dragged the rollup) | GREEN (applicability = active; quiet topics no longer drag it) | Yes |

Order layer: BEFORE 989 / 1000 red. AFTER 508 green, 40 red, 452 unknown. The 40 reds
are genuinely aged (>72h, up to 7 days) unshipped orders (correct real stalls); the
452 unknown are wholesale rows with no read-only received-time anchor (never a false
red). The rollup headline is `stuck (red)` BECAUSE of the 40 real stalls, which is a
truthful signal, not crying wolf.

Rollup counts (ADR-0008 neutral counting): active pipes = 4 (price_sync disabled and
back_sync idle_no_traffic are neutral, correctly excluded), of which 3 green + 1 amber
(inventory_sync divergence), 0 red.

## Verdict of the round

Five of the six pipes now read correctly (green, or a truthful neutral state) on a
healthy system, up from ZERO green before. The sixth (inventory_sync) has its
freshness and liveness green (the Unit 3 fix landed); its remaining amber is the
amber-capped, never-red dry-run divergence signal, which is informational by design,
not a false alarm. The order layer went from 989 false reds to 40 genuine reds. True
faults still fire: the 40 aged orders red and drive the headline to stuck, and each
pipe compute still reds/ambers on a real fault (proven by the node:test suite,
238 tests).

## Known follow-ups (surfaced, not blocking)

- The Shopify inventory reconciliation reported 43 of 46 sampled SKUs diverging. This
  is a comparison artifact: NAV availability was summed across ALL locations while
  Shopify's set quantity reflects the fulfillment-service location only. The
  reconciliation needs location scoping before its divergence is trustworthy. It is
  surface-only (it never affects the verdict), so it does not distort the grade.
- price_sync and shopify_webhook Shopify-side reconciliations are delivered and
  unit-tested but not wired live (price needs a NAV price read; the webhook outcome
  needs a reliable Shopify-name to NAV-order match).
