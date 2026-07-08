# Design: `forward_sync` pipe — "Shopify order exported but not in NAV"

Handoff spec for a builder thread. Implements a new observability pipe in the
Order Health dashboard that surfaces the failure mode we just hit in production:
Shopify DTC orders that the middleware tagged as exported, but that never
created a Sales Order in NAV. Follow `docs/phase-w-adding-a-pipe.md` exactly;
this doc fills in the domain specifics for that recipe.

Pipe id: `forward_sync`. Panel title: **Forward Sync (Shopify → NAV)**.
Reference implementation to copy in every step: the `inventory_sync` unit.

---

## 0. Why this pipe exists (the signal)

The Shopify→NAV order export can silently stall for a window: orders keep the
`1-Status:Shopify-Exported!` tag but the NAV Sales Order create never commits,
and nothing flags it. On 2026-07-01 a ~36-order contiguous block
(`SP-319121`..`SP-319156`) plus scattered singletons were lost this way; they
were only found by manual inspection. This pipe makes that condition a
first-class, alerting health verdict instead of an accidental discovery.

Boundary (design.md §0/§7, and this repo's charter): **read-only everywhere.**
This pipe reads Shopify-order tag state (via the middleware's read-only surface)
and NAV Sales Header/Invoice read-only, and writes only this service's own
snapshot row. It never re-drives the export (that stays a human action in the
middleware UI / the `Recover-StuckOrders.ps1` runbook).

---

## 1. Correlation + detection semantics (the crux)

**NAV order-number shape.** A Shopify order named `SP-<n>` becomes one or more
NAV orders named `SP-<n>-<leg>` (the warehouse splitter emits one NAV order per
shipment leg, e.g. `SP-319241-1`, `SP-319241-2`). So a Shopify order is "in NAV"
iff at least one NAV document exists whose order number starts `SP-<n>-`.

**Where NAV documents live** (check both; a posted order leaves Sales Header and
appears as an invoice):
- `GRUS$Sales Header` — column `No_` (open orders).
- `GRUS$Sales Invoice Header` — column `[Order No_]` (posted orders).
- (Optional completeness) `GRUS$Sales Header Archive` `No_` — catches
  created-then-deleted; if an order is only ever in archive with no invoice,
  treat as NOT fulfilled-through.

**Shopify "exported / pending" tag state** (the candidate set):
- `1-Status:Shopify-Exported!` — middleware handed off but NAV import not
  confirmed. A successful import REMOVES this tag and adds
  `1-Status:Middleware-Imported!` → later `1-Status:NAV-Created!`. So an order
  that still carries `Shopify-Exported!` has not completed import.
- `1-Middleware Status!` — wedged a stage further in (e.g. `SP-319187`). Include
  it; it is the same "not in NAV yet" class, different stall point.

**A "stuck" order** = carries one of those tags AND has no NAV document under
`SP-<n>-%` AND is older than the grace window (below).

**Known false positives to exclude** (so the pipe does not cry wolf):
- Orders younger than `graceMinutes` — legitimately still in-flight.
- Orders before `dateFloorIso` (optional) — skips the historical May 21–22
  cutover-gap cluster (`SP-311050`..`SP-311133`) and stale 2024–2025 tag lint,
  which are a different, already-triaged situation. Default the floor to the
  current NAV cutover date; make it config so Ops can widen it.

---

## 2. Step-by-step against `phase-w-adding-a-pipe.md`

### Step 1 — Source shapes (read-only stubs), DevOps-gated

`backend/src/sources/middlewareClient.ts` — add:

```ts
export interface ExportedPendingOrder {
  shopifyOrderName: string;   // "SP-319121"
  shopifyOrderNumber: string; // "319121"  (the <n> used for the NAV LIKE)
  createdAt: string;          // ISO; ages the backlog
  tag: 'shopify_exported' | 'middleware_status';
}
// Stub returns [] (typed). DevOps wires the live read-only source later:
//   Shopify Admin: orders with status:open and
//     tag:'1-Status:Shopify-Exported!'  (pass 1)
//     tag:'1-Middleware Status!'         (pass 2)
//   fetched via the middleware's existing read-only order surface, NOT a new
//   Shopify token in this service. Return name, number (name minus 'SP-'),
//   created_at, and which tag matched.
getExportedPendingOrders(): Promise<ExportedPendingOrder[]>
```

`backend/src/sources/navClient.ts` — add:

```ts
// Which of these Shopify numbers already have ANY NAV document under SP-<n>-%.
// Stub returns new Set(). Live read-only query (parameterize the list):
//   SELECT DISTINCT LEFT(No_, LEN(No_)) ... -- see below
getNavPresentShopifyNumbers(numbers: string[]): Promise<Set<string>>

// Liveness: when did the export last succeed (most recent NAV order created
// from a Shopify order). Stub returns null. Live read-only query:
//   SELECT MAX([Order Date]) FROM [GRUS$Sales Header] WHERE No_ LIKE 'SP-%'
//   (or MAX(create timestamp) if a reliable created-at column exists)
getLastForwardSyncSuccessAt(): Promise<string | null>
```

Documented live SQL for presence (put in the comment, one round trip):

```sql
-- @numbers = ('319121','319122',...)
SELECT DISTINCT SUBSTRING(No_, 4, CHARINDEX('-', No_+'-', 4) - 4) AS num
FROM   [GRUS$Sales Header]
WHERE  No_ LIKE 'SP-%'
UNION
SELECT DISTINCT SUBSTRING([Order No_], 4, CHARINDEX('-', [Order No_]+'-', 4) - 4)
FROM   [GRUS$Sales Invoice Header]
WHERE  [Order No_] LIKE 'SP-%';
-- intersect the returned nums with @numbers in code (or add an IN (...) filter).
```

Keep it read-only. Do NOT make live calls in this service; sources stay stubbed
until DevOps wires them behind the same interface (recipe step 1).

### Step 2 — Pure compute module `backend/src/aggregator/forwardSync.ts`

Model on `inventorySync.ts`. Export:

```ts
export interface ForwardSyncThresholds {
  graceMinutes: number;          // ignore orders younger than this
  dateFloorIso: string | null;   // ignore orders created before this (cutover noise)
  backlogAmberMinutes: number;   // oldest stuck age >= this => AMBER
  backlogRedMinutes: number;     // oldest stuck age >= this => RED
  backlogAmberCount: number;     // >= this many stuck (past grace) => at least AMBER
  backlogRedCount: number;       // >= this many => RED
  livenessAmberMinutes: number;  // no successful import in this long => AMBER
  livenessRedMinutes: number;    // ... => RED
}

export interface ForwardSyncInput {
  exported: ExportedPendingOrder[];     // candidate set (both tags)
  navPresent: Set<string>;              // shopify numbers already in NAV
  lastSuccessAt: string | null;         // liveness source
}

export function computeForwardSync(
  input: ForwardSyncInput,
  t: ForwardSyncThresholds,
  nowMs: number,
): { freshnessVerdict: Verdict; livenessVerdict: Verdict;
     pipeVerdict: Verdict; detail: ForwardSyncDetail };
```

Compute logic (pure; no I/O, no `Date.now()`):

1. **Backlog** = `exported` filtered to: number NOT in `navPresent`, AND
   `age >= graceMinutes`, AND (`dateFloorIso` null OR `createdAt >= dateFloorIso`).
2. `oldestAgeS = max age over backlog` (null if empty); `count = backlog.length`.
3. **freshnessVerdict** (backlog): GREEN if count 0. Else escalate by the worse
   of the age band (`>= backlogRedMinutes` RED, `>= backlogAmberMinutes` AMBER)
   and the count band (`>= backlogRedCount` RED, `>= backlogAmberCount` AMBER);
   floor at AMBER once count ≥ 1 past grace (a real stuck order is never GREEN).
4. **livenessVerdict**: `mins = (now - lastSuccessAt)`. GREEN under
   `livenessAmberMinutes`, AMBER within, RED past `livenessRedMinutes`.
   `lastSuccessAt === null` ⇒ `unknown` (source not wired), not RED.
5. `pipeVerdict = worstVerdict([freshnessVerdict, livenessVerdict])`.
6. Build `detail` (below), including a sorted sample (oldest first, cap ~25) and
   a `contiguousBlock` flag: true when ≥ `backlogRedCount` backlog orders fall in
   one tight created-at window (the "export stalled for a window" fingerprint).

### Step 3 — Shared detail type `shared/src/index.ts`

`PipelineHealth` already carries `freshness_verdict` + `liveness_verdict`.
Put everything else in a typed detail bag and register the pipe id:

```ts
export interface ForwardSyncDetail {
  backlog_count: number;
  oldest_age_s: number | null;
  newest_age_s: number | null;
  last_success_at: string | null;
  contiguous_block: boolean;               // the "lost a window" fingerprint
  sample: Array<{                          // oldest-first, capped
    shopify_order_name: string;
    age_s: number;
    created_at: string;
    tag: 'shopify_exported' | 'middleware_status';
  }>;
}
```

Add `'forward_sync'` to the `PipeName` union (and any exported pipe-id list).
Check `db/migrations/0001_init.sql`: if `pipeline_health_snapshot.pipe` has a
CHECK/enum constraint, add a forward migration adding `'forward_sync'`; if it is
a free string, no migration needed.

### Step 4 — Writer seam `backend/src/aggregator/writers.ts`

Add `computeForwardSyncPipeline(sources)` copying
`computeInventorySyncPipeline`: read the three sources, assemble
`ForwardSyncInput`, call `computeForwardSync(...)`, map result → the
`PipelineHealth` row (`pipe:'forward_sync'`, `freshness_verdict`,
`liveness_verdict`, `detail`, `as_of`). Replace the `placeholderPipe('forward_sync')`
entry in `computePipelines` with it.

### Step 5 — Config `backend/src/config.ts` + `.env.example`

Add a `forwardSync` block read from env with defaults; document each in
`.env.example`. Suggested defaults:

| Key | Default | Meaning |
|---|---|---|
| `FORWARD_SYNC_GRACE_MINUTES` | 15 | ignore orders younger than this (in-flight) |
| `FORWARD_SYNC_DATE_FLOOR` | (empty) | ignore orders before ISO date (cutover noise) |
| `FORWARD_SYNC_BACKLOG_AMBER_MINUTES` | 30 | oldest stuck age → AMBER |
| `FORWARD_SYNC_BACKLOG_RED_MINUTES` | 120 | oldest stuck age → RED |
| `FORWARD_SYNC_BACKLOG_AMBER_COUNT` | 1 | this many stuck → AMBER |
| `FORWARD_SYNC_BACKLOG_RED_COUNT` | 5 | this many stuck → RED |
| `FORWARD_SYNC_LIVENESS_AMBER_MINUTES` | 60 | no import in this long → AMBER |
| `FORWARD_SYNC_LIVENESS_RED_MINUTES` | 180 | ... → RED |

### Step 6 — Tests `backend/src/aggregator/forwardSync.test.ts` (node:test)

Seeded inputs + fixed `NOW`. Assert each boundary:
- 0 backlog ⇒ freshness GREEN.
- 1 stuck just past `graceMinutes`, young ⇒ AMBER (count floor), not GREEN.
- oldest ≥ `backlogRedMinutes` ⇒ RED even at count 1.
- count ≥ `backlogRedCount` ⇒ RED even when young.
- order younger than grace ⇒ excluded (not counted).
- order before `dateFloorIso` ⇒ excluded.
- order present in `navPresent` ⇒ excluded (the happy path).
- liveness: `lastSuccessAt` null ⇒ `unknown`; within amber band ⇒ AMBER; past red ⇒ RED.
- rollup = worst of the two; `contiguous_block` true when the RED-count backlog
  clusters in one window.
- invariant: multi-leg present (`SP-<n>-2` exists) still counts the order as
  present (correlation is on `<n>`, not the leg).

### Step 7 — Panel `frontend/src/components/ForwardSyncPanel.tsx` + mount

Copy `InventoryPanel.tsx`. Two `VerdictChip`s: **Export liveness** and
**Backlog (exported not in NAV)** (shape-encoded, not color-only). Headline:
`N orders exported but not in NAV · oldest {h m} · last import {ago}`. Small
oldest-first table from `detail.sample` (order name, age, which tag). Show a
"stalled window detected" note when `detail.contiguous_block`. Reads ONLY the
handed-in snapshot row; cast `pipe.detail as ForwardSyncDetail`. Mount under
`<PipelineStrip>` in `App.tsx` selecting `pipelines.find(p => p.pipe === 'forward_sync')`.
Add panel CSS to `styles.css` using existing dark-theme tokens.

---

## 3. Remediation pointer (optional, matches the repo's registry)

Register a **non-auto** remediation entry in `backend/src/remediation/registry.ts`
for `forward_sync` (the repo already forbids auto-trigger — see
`noAutoTrigger.test.ts`; keep it link/instructions only): point operators at
**middleware → Fulfillment Recovery → Missed Shipments → "Force forward-sync
(Shopify → NAV)"** for singles, the **Bulk force-replay by date window** card for
a block, and the `Recover-StuckOrders.ps1` runbook. Never call the middleware
mutation from this service.

---

## 4. Invariants to preserve (recipe §"Invariants")

- Read-only everywhere; the only write is this service's own snapshot row.
- Verdicts encoded by shape via `VerdictChip`, rolled up with `worstVerdict`.
- Keep `as_of` on the response. Sources stay stubbed until DevOps wires them.
- Correlation is on the Shopify number `<n>`, never the leg suffix.

## 5. Open questions for the builder / Mari

- Preferred read path for the Shopify tag set: does the middleware already expose
  a read-only "orders by tag" endpoint, or should NAV-side staging tables be the
  source of "what the middleware thinks it exported"? (Either satisfies the
  read-only boundary; pick whichever DevOps can wire without a new Shopify token.)
- Confirm `dateFloorIso` default (the current NAV/middleware cutover date) so the
  historical May cutover cluster is excluded by default.
- Confirm there is no reliable NAV "created-at" timestamp better than `[Order Date]`
  for liveness; if there is, use it.
