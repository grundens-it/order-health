# Phase W: adding a pipe monitor (copy the Inventory Sync Monitor)

Unit 1 (the Inventory Sync Monitor, `pipe = 'inventory_sync'`) is the reference
implementation. Units 2 to 6 (back-sync, price-sync, NAV job queue, Shopify
webhooks, allocator) each own exactly one `pipeline_health_snapshot` row plus one
panel, and they follow the identical shape. This note is the recipe.

Boundary reminder (design.md section 0 and 7): every source read is READ-ONLY.
The monitor reads the middleware's existing read-only endpoints and NAV
read-only, and writes ONLY this service's own Postgres snapshot. No pipe adds a
mutation path to the middleware or NAV.

## The seven steps

1. **Add the source shapes (read-only).** In `backend/src/sources/navClient.ts`
   and/or `middlewareClient.ts`, add the typed method(s) your pipe needs and the
   stub implementation that returns typed empty/placeholder data. Keep the real
   read-only query/HTTP shape in a comment so DevOps can wire the live client in
   behind the same interface later (exactly as `getInventoryWatermarkState`,
   `getRecentInventoryWalks`, and `getInventorySyncStatus` do). Do NOT make live
   calls: sources are DevOps-gated.

2. **Write a PURE compute module.** Create `backend/src/aggregator/<pipe>.ts`
   modelled on `inventorySync.ts`. It exports a thresholds interface, a seeded
   `<Pipe>Input` interface, and a pure `compute<Pipe>(input, thresholds, nowMs)`
   that returns the sub-verdicts, the rollup `pipeVerdict = worstVerdict([...])`,
   and a typed `detail` bag. Pure means: no I/O, no `Date.now()` inside (take
   `nowMs`), so every verdict boundary is unit-testable without a live source.

3. **Put the sub-verdicts where they belong.** `PipelineHealth` has top-level
   `freshness_verdict` and `liveness_verdict` columns; any additional sub-verdict
   (Unit 1's push-outcome / divergence verdict) lives inside the typed `detail`
   bag defined in `shared/src/index.ts`. Add your pipe's `detail` interface there
   so backend and frontend agree on the shape.

4. **Wire the compute into the writer seam.** In
   `backend/src/aggregator/writers.ts`, add `compute<Pipe>Pipeline(sources)` (copy
   `computeInventorySyncPipeline`): read the sources, assemble the seeded input,
   call the pure compute, and map the result to the `PipelineHealth` row. Replace
   your pipe's `placeholderPipe(...)` entry in `computePipelines`.

5. **Add thresholds to config, never hardcode.** Add a `<pipe>` block to
   `backend/src/config.ts` (read from env with sensible defaults) and document
   each key in `.env.example`. Ops tunes the bands; the code reads them.

6. **Write verdict-correctness tests.** Create
   `backend/src/aggregator/<pipe>.test.ts` using `node:test` (see
   `inventorySync.test.ts`). Assert each verdict at its boundary over SEEDED
   inputs with a fixed `NOW`, plus any invariant your pipe promises (Unit 1
   asserts the dry-run divergence caps at AMBER and never RED). `npm test`
   auto-discovers `src/**/*.test.ts`.

7. **Add the panel and mount it.** Create
   `frontend/src/components/<Pipe>Panel.tsx` (copy `InventoryPanel.tsx`): the
   verdict cards use `VerdictChip` (shape-encoded, never color alone), and the
   panel reads ONLY the snapshot row it is handed (no live fan-out). Cast
   `pipe.detail` to your shared detail type. Mount it under `<PipelineStrip>` in
   `frontend/src/App.tsx`, selecting your row with
   `pipelines.find((p) => p.pipe === '<pipe>')`. Add panel CSS to `styles.css`
   using the existing dark-theme tokens.

## Invariants to preserve

- Every health response keeps its `as_of` (the snapshot materialization time).
- Verdicts are encoded by SHAPE as well as color (accessibility): reuse
  `VerdictChip`.
- Roll up with `worstVerdict([...])`. If a sub-verdict is deliberately capped
  (like Unit 1's amber-never-red divergence), cap it at compute time AND before
  the rollup, so it cannot escalate the pipe past its cap.
- Read-only everywhere. The only writes in the system are the aggregator writing
  this service's own snapshot tables.
