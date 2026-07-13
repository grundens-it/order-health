# Finding: the 98.9% order red rate is a broken stage-timestamp join, not the bands

> Unit 6 (health-fidelity), research-first. Investigated against the code path and
> the read-only NAV client shapes. Read-only NAV and middleware; no writes. No em dashes.

## Symptom

At a healthy moment on 2026-07-13 the live dashboard graded 989 of 1000 orders RED,
oldest stuck 6.8 days, with orphan grading OFF. A 98.9% red rate on a healthy system
is not a useful order signal.

## Two hypotheses (from the kickoff)

1. The stage-age BANDS are wrong (`ORDER_STAGE_*` 30/60 min, `ORDER_AWAITING_SHIP_*`
   24/72 h too tight).
2. The stage-timestamp JOINS are wrong, so orders look stuck at a stage they already
   passed (a null `navPromotionAt` / `backSyncAt` reading as "never happened").

## Root cause: hypothesis 2 (the join), confirmed against read-only NAV

The order grader (`orderLifecycle.ts`) is correct: given a per-order hop chain with
real timestamps it grades each hop against its band and treats future hops as not yet
due. The defect is UPSTREAM, in the derivation `buildOrderInput` (writers.ts), which
assembles the hop chain from a `NavOrderLifecycleRow`.

The full DTC chain is `shopify_order -> allocator_split -> nav_staging ->
nav_promotion -> awaiting_ship -> nav_shipment -> back_sync`. But four of those hop
completion timestamps are MIDDLEWARE-sourced, and the read-only NAV client
(`mapOrderLifecycleRow`) cannot populate them: it returns

- `allocatorSplitAt = null`
- `navStagingAt = null`
- `navPromotionAt = null`
- `backSyncAt = null`

Only `shopifyOrderAt` (the NAV order date) and `navShipmentAt` (MAX shipment posting)
come from NAV. So for a live DTC order the chain is:

```
shopify_order  completed = orderDate     (observed)
allocator_split completed = null, entered = orderDate   <-- FIRST INCOMPLETE
nav_staging    completed = null
nav_promotion  completed = null
awaiting_ship  completed = navShipmentAt
...
```

`gradeOrder` finds the first hop with a null completion (`allocator_split`), treats it
as the pending frontier, and ages it from `orderDate` against the 30/60 min staging
band. Since virtually every one of the 1000 most-recent orders is older than 60 min,
almost every order reds at `allocator_split`. Even an order that already SHIPPED reds,
because `allocator_split.completedAt` is still null so the grader never advances past
it. That is exactly the "null timestamp reading as never-happened" mechanism, and it
is independent of the bands: widening the bands would only delay the false red.

The bands themselves are fine: a normally-progressing order that shipped within a day
should be green, and the 24/72 h awaiting-ship band is a reasonable fulfillment SLO.

## The fix (honouring ADR-0007: NAV read-only is the system of record)

Fix the derivation, not the grader. From read-only NAV the authoritative evidence per
order is: it was RECEIVED (`orderDate`), whether it SHIPPED (`navShipmentAt`), the
staging `Status`, and the missed-back-sync reconciliation. Per ADR-0007, green means
the middleware's step landed and the record confirms it; non-green means the record
shows a divergence. So INFER each unobservable completion from that evidence instead
of reading a null as "stuck":

- The unobservable intermediate hops (`allocator_split`, `nav_staging`,
  `nav_promotion`) are inferred COMPLETE (from the shipment when shipped, else from the
  received time), so a normally-progressing order is not pinned at `allocator_split`.
- A not-yet-shipped DTC order is then graded at its `awaiting_ship` frontier from the
  received time against the awaiting-ship band (24 h amber / 72 h red): a recent order
  is GREEN, a days-old unshipped order still reds.
- `nav_staging` still latches RED when NAV shows a real stuck staging row (`Status != 0`
  and not yet shipped): a genuine staging fault is preserved.
- `back_sync` completion is unobservable from NAV, so it is inferred from the shipment
  and the missed-back-sync flag: a missed back-sync still reds; otherwise it is not
  aged (its absence of an observable timestamp is not a fault).

Result: a healthy, normally-progressing order reads GREEN, while the true faults
(a real staging stuck row, a missed back-sync, a days-old unshipped order) still fire.

## Scope note (surfaced, not decided)

Wholesale orders carry no received-time anchor in the read-only NAV row, so an
unshipped wholesale order reads `unknown` (not a false red) rather than being aged;
adding a wholesale received-time anchor is a follow-up. The awaiting-ship band values
(24 h / 72 h) are the existing config defaults, surfaced for Ops to tune.
