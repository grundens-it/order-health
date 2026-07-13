# ADR-0008: A non-verdict "applicability" display state for fine-nothing-to-report pipes

- Status: Accepted (Architect seat, 2026-07-13).
- Deciders: Steve (operator), Architect seat.
- Companion: ADR-0007 (source-of-truth precedence + reconciliation), the health-fidelity kickoff section 3, `shared/src/index.ts` (the `Verdict` union).

## Context

Two pipes today read `unknown` when the truth is "fine, nothing to report":

- price_sync is a DISABLED feature (the middleware reports `enabled:false`, `last_run_at:null`, zero recent rows). All its timestamps are null, so the cycle-band compute returns `unknown`.
- shopify_webhook rolls up to `unknown` because low-volume topics (orders/cancelled, fulfillments/update, orders/create) are simply quiet and have no receipt in the bounded recent page, even though all six subscriptions are active and the busy topics are fresh.

`unknown` renders like a broken sensor (a dash), and worse, it pollutes the rollup: a quiet topic drags the whole webhook pipe to unknown, and unknown is worse than green in the `worstVerdict` severity table. Neither pipe has a real problem, yet both read as if a source were down.

The question: how do we display "correctly not reporting" distinctly from "should be reporting and is not"?

## Decision

Adopt Option A. Add a non-verdict DISPLAY state carried inside `PipelineHealth.detail`, not a new member of the `Verdict` union.

- A new optional detail field, `applicability: 'active' | 'disabled' | 'idle_no_traffic'`, is added to the shared detail bags for the affected pipes (price_sync and shopify_webhook). `active` is the normal case and is the default when the field is absent.
- `disabled` means the feature is deliberately off (price_sync when the middleware reports it disabled).
- `idle_no_traffic` means the pipe is healthy and correctly subscribed / configured but has no work or traffic to report in the window (a quiet webhook topic, an idle back-sync stretch).
- The rollup (`rollup.ts` and the `RollupCounts` tally) treats a pipe whose applicability is `disabled` or `idle_no_traffic` as NEUTRAL: it is not counted as unknown and not counted as red or amber, and it does not move the leadership headline off healthy. It still appears in the strip with its own labelled state so an operator can see it is deliberately quiet, not broken.
- The `Verdict` union stays `green | amber | red | unknown`. `VerdictChip` and every rollup that enumerates verdicts are untouched. Only the presentation (a new chip / label for the applicability state) and the rollup COUNTING change.

### Why not Option B (extend the `Verdict` union with `not_applicable`)

Option B is cleaner semantically but has a large blast radius: it touches `shared/src/index.ts` (the union and the `VERDICT_SEVERITY` table), `VerdictChip`, every `worstVerdict` call site, every rollup tally, and every test that enumerates the four verdicts. For a display concern that only two pipes need, that churn is not justified. Option A keeps the shared contract stable and confines the change to the two pipes plus the rollup counting.

## Consequences

- `shared/src/index.ts`: add `applicability?: PipeApplicability` (with `PipeApplicability = 'active' | 'disabled' | 'idle_no_traffic'`) to `PriceSyncDetail` and `ShopifyWebhookDetail`. Optional, so existing rows and tests default to `active`.
- price_sync (Unit 5): when the middleware reports the feature disabled (all timestamps null AND an explicit disabled signal), set `applicability: 'disabled'` and a green-neutral pipe verdict rather than `unknown`. A disabled feature is not a fault and must not read like a broken sensor.
- shopify_webhook (Unit 5): a subscribed topic with no recent traffic reads `idle_no_traffic` (via a per-topic expected cadence or an extended look-back) rather than `unknown`. The subscription-drop signal (a genuinely missing subscription) is UNCHANGED and still goes amber-or-worse, because that is the real WAF-removal failure mode.
- rollup.ts (Unit 5): the tally and the headline computation exclude pipes whose applicability is `disabled` or `idle_no_traffic` from the unknown / amber / red counts, so a deliberately quiet pipe cannot drag the rollup.
- No `Verdict`-enum change, so no shared-enum churn and no test rewrites across pipes that do not need this.
- Firm boundary preserved: this is a display-and-counting change only. It never turns a genuine fault green; a real missing subscription, a real stale watermark, or a real error still reds or ambers as before.

## References

- The health-fidelity kickoff section 3 (the two options, Option A recommended).
- The 2026-07-13 validation results (price_sync UNKNOWN "disabled by design"; shopify_webhook UNKNOWN from quiet topics).
- ADR-0007 (the reconciliation model this round implements alongside this display decision).
