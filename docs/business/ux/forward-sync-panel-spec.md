# Screen spec: ForwardSyncPanel (forward_sync pipe)

> Grundens UX seat, Session A (screen spec). Status: Draft. Companion to `docs/architecture/forward-sync-pipe.md` (Architect) and `docs/business/forward-sync-requirements.md` (BA). No em dashes.
> Brand-token verification: all tokens this panel needs are defined as CSS variables in `frontend/src/styles.css` and reused via existing classes. Token-source gap: there is no `docs/architecture/brand-and-visual-direction.md` yet, so the tokens are not formalized in a brand doc. Handoff to the Architect seat to formalize them; this spec consumes them as-is and defines none.

## 1. Purpose

Support US-1, US-4, US-5, US-6, US-9. Give an Ops operator, at a glance, whether Shopify orders were exported but never created in NAV, how bad the backlog is, whether the export has stalled entirely, and a one-click path to the existing manual recovery. It reads only the handed-in `pipeline_health_snapshot` row for `pipe = 'forward_sync'`. No live fan-out.

## 2. Layout

Copy the structure of `InventoryPanel`, but two verdict cards instead of three (use the existing `.ip-cards-2` grid, as `BackSyncPanel` does).

Top to bottom:

1. `PipeActions` header (existing component): the pipe name and the remediation entry point.
2. `.ip-cards-2`: two `VerdictCard`s, "Backlog (exported not in NAV)" then "Export liveness".
3. Headline line (one sentence, below the cards).
4. Stalled-window note (`.ip-note`), rendered only when `detail.contiguous_block` is true.
5. Backlog sample table (`.tblwrap` / `table`), oldest-first, rendered only when the sample is nonempty.

Responsive: `.ip-cards-2` collapses two columns to one at the existing 900px breakpoint. No new breakpoints.

## 3. Content

Card mapping onto the existing `PipelineHealth` columns (per the Architect field mapping):

- Card 1, "Backlog (exported not in NAV)": verdict = `freshness_verdict`. Metric = `{backlog_count} orders` (or `0 orders`). Sub = `oldest {humanAge(watermark_lag_s)} · newest {humanAge(detail.newest_age_s)}`. InfoTip: "Shopify orders the middleware tagged as exported that have no matching NAV Sales Order. Older and more numerous is worse; a single stuck order is never green."
- Card 2, "Export liveness": verdict = `liveness_verdict`. Metric = `last import {humanAge(heartbeat_age_s)}`. Sub = "time since the last Shopify to NAV order was created". InfoTip: "Whether the export is running at all. Independent of the backlog: nothing importing is a stall even before a backlog builds. Unknown until the source is provisioned."

Headline (below the cards), by state:

- Populated: `{backlog_count} orders exported but not in NAV · oldest {h m} · last import {ago}`.
- Zero backlog, source wired: `No exported orders pending in NAV · last import {ago}`.
- Source not wired: `Forward-sync source not yet provisioned (read-only, DevOps-gated)`.

Stalled-window note (when `detail.contiguous_block`): an icon plus text (not color alone), for example `<i aria-hidden> Stalled window detected: {backlog_count} orders lost in one created-at window. Likely a systemic export stall, not scattered stragglers.` Use `.ip-note.r` when the pipe is red, `.ip-note.a` when amber, so the note tone tracks the verdict.

Backlog sample table columns (from `detail.sample`, oldest first, capped at about 25):

- Order: `shopify_order_name` (mono). InfoTip: "The Shopify order name (SP-<n>). Correlation is on the number, not the shipment leg."
- Age: `humanAge(age_s)` (mono).
- Tag: a text label pill, "Exported" for `shopify_exported`, "Middleware" for `middleware_status`. InfoTip: "Which stall stage the order is wedged at."

## 4. Interaction

- A `VerdictCard` becomes actionable (role="button", tabIndex 0, Enter/Space activates, pointer cursor, "Resolve ->" affordance) exactly when its verdict is red or amber and `onRemediate` is provided, identical to `InventoryPanel`'s `VerdictCard`. Activating opens the `RemediationModal` for subject `{ subjectKind: 'pipe', subjectKey: 'forward_sync' }`.
- The remediation content is link-only and non-auto (US-9): it names the middleware Fulfillment Recovery path (force forward-sync single, bulk replay by date window) and the `Recover-StuckOrders.ps1` runbook. No control on this panel re-drives the export, and nothing auto-fires.
- InfoTips open on hover and on keyboard focus (existing `InfoTip` behavior).
- No live fan-out on any interaction. The panel only reads its snapshot row.

## 5. States

- Null / no snapshot: `.ip-empty` with copy "No forward-sync snapshot yet. The aggregator writes this row on the order-layer cadence (sources are read-only and DevOps-gated)." (Mirror `InventoryPanel`'s empty state.)
- Unknown / source not wired (US-7): both chips render `unknown` (dash shape + "Unknown" label), the headline shows the "not yet provisioned" line, and no false green appears. This is the critical state: a blind source must never read healthy.
- Green: zero backlog and liveness green. Cards green, no note, no table, headline shows the zero line.
- Amber / Red: cards colored and actionable, headline populated, sample table shown, stalled-window note shown when `contiguous_block`.
- Mixed: backlog green but liveness red (nothing importing, no backlog yet) rolls the pipe to red via `worstVerdict`; the liveness card carries the red and is the actionable one.

## 6. Brand tokens consumed

All from `frontend/src/styles.css` (reused via existing classes; none redefined here):

- Surfaces: `--card`, `--sunken`, `--line`, `--line2`, `--radius` (via `.ip-card`, `.ip-cards-2`, `.tblwrap`).
- Verdict color and shape: `.chip.g/.a/.r/.u` with the shape-encoded `.ic` (circle / rounded square / rotated diamond / dash), plus `--green`, `--amber`, `--red`, `--slate` and their `-bg` / `-bd` pairs.
- Notes: `.ip-note`, `.ip-note.a`, `.ip-note.r`.
- Text: `--ink`, `--muted`, `--faint`; `mono` for order and age cells.
- Tag pill: `--slate-bg` background with `--slate` text (token-based, text label carries the meaning, color is decorative only).

No new token is required. New CSS is limited to an optional `.fs-tag` pill class built entirely from the tokens above; if even that is avoidable by reusing an existing chip-like class, prefer reuse.

## 7. Accessibility commitments

Target: WCAG 2.1 AA.

- Color independence: every verdict is conveyed by the `VerdictChip` shape and its text label, never color alone (reused, already conformant). The tag is a text label, not a color. The stalled-window note leads with an icon plus text.
- Keyboard: actionable cards are reachable in tab order, show a visible focus ring, and activate on Enter and Space (matches `InventoryPanel`). The remediation modal traps focus and restores it on close (existing `RemediationModal` behavior; QA to confirm it holds for this subject).
- Screen reader: the sample table is a real `table` with `th` headers so rows are announced with column context. `VerdictChip` exposes `role="status"` and `aria-label` (existing). Decorative icons carry `aria-hidden`.
- Contrast: the note text colors (`#e8c88a` on `--amber-bg`, `#f0a49c` on `--red-bg`) and the chip text on their tinted backgrounds are intended to meet AA; QA to verify the ratios against the tokens.
- Motion: no animation is introduced, so `prefers-reduced-motion` needs no special handling here.

## 8. Out of scope

- Any control that re-drives, replays, or mutates the export (stays a human action via the linked runbook).
- A per-cycle bar chart (forward_sync has no walk-count time series; the sample table is the detail surface).
- Per-order actions beyond surfacing the order in the sample and routing to the shared recovery link.

## 9. Handoffs

- Architect seat: formalize the dark-theme tokens into `brand-and-visual-direction.md` (token-source gap above); confirm the `forward_sync` field mapping this spec assumes.
- BA seat: the copy here assumes the tag labels "Exported" and "Middleware"; confirm against the authoritative tag list (BA open confirmation 5).
- QA seat: translate section 7 into accessibility test cases (keyboard activation of the cards, screen-reader table semantics, the unknown-not-green state, contrast ratios).
- Claude Code: implement `frontend/src/components/ForwardSyncPanel.tsx` per this spec, mounting under `PipelineStrip` selecting `pipelines.find((p) => p.pipe === 'forward_sync')`.
