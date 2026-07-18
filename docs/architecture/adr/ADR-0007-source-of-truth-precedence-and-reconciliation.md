# ADR-0007: Source-of-truth precedence and the reconciliation model for health signals

- Status: Accepted (Architect seat, 2026-07-13).
- Deciders: Steve (operator), Architect seat.
- Companion: ADR-0002 (materialized snapshot), the health-fidelity kickoff (`docs/kickoffs/health-fidelity-fixes-kickoff.md`), the live evidence (`docs/business/order-health-validation-results-2026-07-13.md`).
- Supersedes: the middleware-adoption stance in ADR-0002 FOR HEALTH SIGNALS ONLY (see below). ADR-0002's snapshot-aggregator decision stands unchanged.

## Context

The live run on 2026-07-13 showed the dashboard displaying ZERO green pipes on a healthy system: 3 amber, 3 unknown, and 989 of 1000 orders red, at a moment when CU 50009 auto-release had just fired, zero shipments were missed over 14 days, the allocator was deciding every minute, inventory walks were running, and webhooks were flowing. Every one of those verdicts was false or not useful.

The root cause traced, in every case, to a middleware-composed proxy rather than to an independent system of record:

- nav_job_queue ADOPTED the middleware's own `level` (`Stuck` for a normal long IABC run), which our map did not recognize, so the pipe flipped to `unknown` while NAV showed auto-release live.
- The staging count was internally inconsistent: the `stuck-staging` endpoint reported 1,988 while the job-queue endpoint reported `pending_staging=0` for the same instant.
- The allocator sanity signal divided an absolute, weeks-deep OOS-held backlog by a recent decision sample.
- The webhook rollup and the back-sync freshness depended on whatever happened to be in a bounded recent feed page.

ADR-0002 (Consequences, line 49) explicitly directed the aggregator to consume "already-computed verdicts (the middleware's `job-queue/health`) rather than recomputing them." That was the right call for bounding NAV load, but it made the middleware BOTH the actor and its own judge. When the actor grades itself, a healthy system can read broken and a broken one can read healthy, and the operator has no independent check.

## Decision

Keep monitoring the middleware as the ACTOR under observation. It is the thing actually doing the work: pushing inventory to Shopify, firing fulfillmentCreate, staging and promoting orders, deciding splits. This round does NOT stop watching it.

What changes: stop TRUSTING the middleware's self-assessment as the verdict. For each health signal, read two things, (a) what the middleware CLAIMS it did, and (b) what the authoritative system of record actually shows, and drive the verdict from the AGREEMENT or DIVERGENCE between them. This is reconciliation, not replacement.

- GREEN means the middleware's action landed AND the system of record confirms it.
- A non-green means either the middleware is behind or failed, OR the middleware and the system of record DISAGREE. When they disagree, the panel must point at exactly where (the SKU, the order, the shipment, the count), not just show a color.

### Source-of-truth precedence (who is authoritative when they disagree)

1. NAV read-only (Azure SQL, `GRUS$`-prefixed, SELECT only). System of record for orders, shipments, staging, the job queue, and inventory availability.
2. Shopify Admin API (read-only). System of record for the storefront side: order and fulfillment state, inventory levels as Shopify holds them, webhook subscription state, prices.
3. Middleware. Always read as the actor under observation: its read-only HTTP observability GETs first, its SQLite directly only as a last resort. For a signal that exists NOWHERE else, the middleware is BOTH the actor and the only source, and the panel must SAY SO.

### Per-signal source and reconciliation map

| Pipe | Middleware claim (monitor) | Authoritative check | Divergence to surface |
|---|---|---|---|
| nav_job_queue | `job-queue/health` level, `stuck-staging` count | NAV: last CU 50009 auto-release, real in-process CU 50007 age, `Status=0` staging rows | Middleware says Stuck / N pending but NAV shows auto-release live and 0 real pending |
| inventory_sync | last walk, per-pair pushed qty | NAV availability vs Shopify Admin inventory levels | Middleware "pushed X" but Shopify holds Y for that SKU / location |
| back_sync | back-sync feed, fulfillment records | NAV posted shipment vs Shopify fulfillment state | NAV shipment posted with no Shopify fulfillment, regardless of the feed |
| shopify_webhook | subscription mirror | Shopify Admin webhook subscriptions + actual order flow | Middleware mirror vs Shopify's real subscription list; a dropped subscription |
| price_sync | price-sync loop state | NAV price vs Shopify price (spot-check) | Feature disabled, or NAV / Shopify price drift |
| allocator | split decisions (`warehouse_allocation_log`) | none (middleware is the only source) | N/A; label middleware-only, reconcile the split target against the NAV location where possible |

The allocator is the deliberate exception: "which DC did the splitter choose" is the middleware's own state with no NAV or Shopify equivalent. Where a unit relies on the middleware alone, that must be a documented "no independent source exists" choice, not a default.

## Consequences

- Unit 1 (nav_job_queue) stops consuming `getJobQueueHealthStatus()` for the verdict and computes it from read-only NAV: liveness from the recency of the last CU 50009 auto-release, health from a genuinely stuck CU 50007 (a normal IABC run is 20 to 47 min, so the threshold sits at about 60 min), and the staging backlog from real `GRUS$Sales Header Staging` rows with `Status = 0`. The middleware's own number is kept on the panel as a labelled cross-check.
- The other pipes keep their NAV / middleware freshness math but their thresholds are recalibrated to the real process cadence (Units 2, 3, 4) so a healthy cadence is not read as degraded.
- New capability implied: the service carries no Shopify credential today. The storefront-side authoritative checks require a read-only Shopify Admin API client with least-privilege scopes (`read_orders`, `read_fulfillments`, `read_inventory`, `read_products`, and the webhook read scope). This is tracked as its own FOUNDATION item (#54 / #55, decided in ADR-0009) and does NOT block the NAV-sourced units. No write scopes, ever. Until it lands, the reconciliations fall back to the NAV-only signal, which is correct but not cross-checked against Shopify.
- Read-only everywhere is unchanged: NAV SELECT-only, middleware GET-only, Shopify read-only. The only write remains this service's own snapshot row. Remediation stays disarmed.
- ADR-0002 is superseded only on the narrow point of adopting the middleware verdict for health signals. Its snapshot-aggregator architecture (bounded NAV load, a single evaluation point, self-disclosing freshness) is retained and is in fact what makes the reconciliation cheap: both the claim and the authoritative read happen once per aggregator cadence, not per page load.

## References

- ADR-0002 (Consequences line 49, the adoption stance now superseded for health signals).
- The health-fidelity kickoff sections 0.1 and 8.
- The 2026-07-13 validation results (the cross-cutting finding: the middleware-derived signals are the weak link).
- ADR-0008 (the verdict-applicability display state, a companion decision from the same round).
