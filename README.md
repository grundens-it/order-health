# order-health

Order Health Observability dashboard for Grundens: one surface that shows, at a glance, whether order and inventory flow across DTC and wholesale is healthy right now, and if not, which order or which pipe is unhealthy and what tool fixes it.

This is a **standalone, read-only** observability service. It is a separate Grundens project and does **not** modify the Symmetry Commerce warehouse-splitter middleware. It reads the middleware's existing read-only HTTP endpoints and NAV read-only, materializes its own health snapshot in its own datastore, and serves its own two-layer UI.

## Where to start

- `docs/kickoffs/order-health-observability.md` — the round kickoff brief (self-contained; sequences and builds the design).
- `docs/architecture/design.md` — the order-health model. Read section 0 (project boundary) and 5A (Inventory Sync Monitor, the reference subsystem) first.
- `docs/architecture/adr/` — the architecture decisions:
  - ADR-0001: standalone read-only service (not an in-app tab in the middleware).
  - ADR-0002: materialized snapshot read-model in this service's own store.
  - ADR-0004: service implementation stack (pending operator sign-off).
- `demo/order-health-dashboard-demo.html` — the visual and interaction spec.

## Boundary

The middleware is production code owned by Symmetry Commerce. This project adds no code, endpoints, migrations, or tables to it, and does not couple to its release cycle. NAV access is read-only. Remediation actions call the middleware's existing authenticated endpoints or documented ops runbooks; they add no mutation path to the middleware.
