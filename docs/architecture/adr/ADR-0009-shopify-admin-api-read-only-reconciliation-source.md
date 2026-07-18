# ADR-0009: Read-only Shopify Admin API as the storefront reconciliation source

- Status: Accepted (Architect seat, 2026-07-13).
- Deciders: Steve (operator), Architect seat.
- Companion: ADR-0007 (source-of-truth precedence and reconciliation), ADR-0008 (verdict-applicability), the health-fidelity integration kickoff.
- Numbering note: this decision was drafted as "ADR-0007" and clashed with ADR-0007 (source-of-truth precedence). It is renumbered to ADR-0009 here; ADR-0007 and ADR-0008 keep their numbers. Issue #55 (which references "[ADR-0007]") is this decision.

## Context

ADR-0007 fixed the source-of-truth precedence: NAV read-only first, then the Shopify Admin API, then the middleware. The Shopify Admin API is the system of record for the storefront side of each reconciliation: order and fulfillment state, inventory levels as Shopify actually holds them, webhook subscription state, and prices. The service carried no Shopify credential, so those storefront-side checks could not run and the reconciliations fell back to the NAV-only signal.

A least-privilege read-only Shopify custom-app credential is now provisioned (issue #55). This ADR records how the service consumes it.

## Decision

Add a read-only `shopifyClient.ts` (`backend/src/sources/`) that talks to the Shopify Admin GraphQL API, mirroring the navClient / middlewareClient stub-then-live pattern:

- GraphQL Admin API, QUERY ONLY. A mutation guard rejects any operation whose body contains a GraphQL `mutation`, as defence in depth on top of the read-only scopes. No write scope is ever requested.
- A live/stub factory: the live client is returned only when the Shopify config is present; otherwise the stub answers with typed empty shapes so the app boots and the reconciliations read `unknown` rather than a false green. On any network / auth / parse failure the live client degrades once to the stub.
- A client-credentials token manager: fetch, cache, and refresh the (~24h) access token; never log the secret.
- Pure, unit-tested mappers turn a fake GraphQL response into the typed shape each reconciliation needs. No network in tests.

### Config (client-credentials)

Read from the environment (`config.ts`), secret only in the gitignored `.env` / host secret store, never committed:

- `SHOPIFY_AUTH_MODE=client_credentials`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET` (secret; gitignored)
- `SHOPIFY_SHOP` (the myshopify domain)
- `SHOPIFY_API_VERSION`

### Reconciliations wired

Per ADR-0007's per-signal map, the Shopify authoritative side of each reconciliation:

- back_sync: Shopify fulfillment state for a NAV posted shipment (the NAV shipment posted vs Shopify fulfillment created divergence).
- inventory_sync: Shopify inventory levels vs the NAV availability the middleware claims it pushed.
- shopify_webhook: outcome reconciliation, Shopify orders vs NAV arrival, sharing the forward_sync machinery; plus the real subscription list vs the middleware mirror.
- price_sync: a Shopify price spot-check against the NAV price.

Where a reconciliation cannot obtain the Shopify datum read-only, the field is left null so the tile reads `unknown`, never a false green.

## Consequences

- A new read-only source with no write path: read scopes only, mutation guard, degrade-to-stub. The only write in the whole system remains this service's own snapshot row.
- The reconciliations upgrade from NAV-only to NAV-vs-Shopify divergence detection; until the client is live they keep the NAV-only signal (still correct).
- ADR-0007 and ADR-0008 are unaffected and remain Accepted; this ADR is the third decision of the health-fidelity round.

## References

- ADR-0007 (precedence + reconciliation), ADR-0008 (applicability).
- Issue #55 (the Shopify client + credential), issue #60 (the integration round umbrella).
- The health-fidelity integration kickoff, Units B and E.
