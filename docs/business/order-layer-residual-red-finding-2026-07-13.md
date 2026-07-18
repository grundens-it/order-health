# Finding: the residual order-layer red rate is a false staging-status trigger

> Unit D (health-fidelity integration), research-first. Sampled the live order rows
> against read-only NAV (SELECT only, no writes). No em dashes.

## Method

Graded all 1,000 live NAV order rows through the exact aggregator path
(`buildOrderInput` then `gradeOrder`, with the shipped config bands), and inspected
the red rows: their channel, order date, shipment presence, staging status, graded
stage, and age.

## Result

```
VERDICT TALLY: green 14, amber 0, red 533, unknown 453
RED current_stage: awaiting_ship 533 (100%)
RED breakdown: dtc 533, wholesale 0, shipped 0, navStagingStatus != 0: 530
awaiting_ship RED age-days: n=533 min 1.0 p25 1.0 median 1.0 p75 1.0 max 7.0
```

Every red is a DTC order at `awaiting_ship`, and 530 of the 533 carry
`navStagingStatus = 1` with an order date of TODAY (median age 1.0 day, not shipped).
The note on those rows is "NAV staging stuck (Status 1)".

## Root cause: Status = 1 is normal, not stuck

The reds are NOT coming from the awaiting-ship age band (median age is 1 day, far
under the 72h red line). They come from the per-order STAGING latched error in
`buildOrderInput`, which fires when `navStagingStatus !== 0 && !shipped`.

That trigger encodes a design assumption that any nonzero staging status is a stuck
order. Live NAV contradicts it: per the 2026-07-13 validation evidence,
`GRUS$Sales Header Staging [Status]`

- `0` = pending promotion (a normal, in-queue state), and
- `1` = "Not Auto-released" (also a normal state; the same rows the middleware's
  stuck-staging endpoint over-counted as 1,988).

So `Status = 1` is the ordinary early-lifecycle state of a freshly received DTC
order, not a fault. Flagging it as a latched red produced 530 false positives on
recently received orders. The three genuine reds are aged orders (up to 7 days,
unshipped) correctly caught by the awaiting-ship band.

There is no field in the current read-only order-lifecycle query that identifies a
GENUINELY stuck staging row (the real conditions, per design.md, are a duplicate
Source Id or a Blocked SKU, which this query does not select). So a staging-status
FLAG cannot be a truthful per-order stuck signal; the honest signal is age based.

## Fix (residual miscalibration, corrected)

Remove the `navStagingStatus !== 0` latched-error trigger from `buildOrderInput`. A
DTC order in staging is graded on the observable NAV signals only: received
(orderDate), whether it shipped (navShipmentAt), and the missed-back-sync
reconciliation. An order that has not shipped is aged at its `awaiting_ship` frontier
against the awaiting-ship band (24h amber / 72h red), so:

- a recently received, not-yet-shipped DTC order reads green (or amber near a day),
  not red, and
- an order genuinely not shipped past the SLO still reds (the 3 aged reds survive),
- a missed back-sync still reds, unchanged.

The staging-backlog concern (many Not-Auto-released rows) remains a PIPE-level signal
(nav_job_queue counts the real Status = 0 pending-promotion rows), not a per-order red.

## Measured effect (live NAV, read-only, after the fix)

Re-graded the same 1,000 live rows through the fixed path:

```
BEFORE: green 14,  amber 0, red 533, unknown 453
AFTER:  green 508, amber 0, red 40,  unknown 452
```

The 494 recently received Status = 1 orders that were falsely red now read green. The
40 remaining reds are all at `awaiting_ship`, genuinely received days ago (the >72h
tail, up to 7 days) and still unshipped, so they are correct. The ~452 unknown are
wholesale rows with no read-only received-time anchor (never a false red). The order
layer now reports a truthful red rate (40 real stalls, not 533 false ones).
