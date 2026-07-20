import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  OosHeldDetail,
  OosHeldOrder,
  RemediationMapping,
  RemediationParam,
  RemediationRegistry,
  RemediationTool,
  RemediationTriggerResult,
  Verdict,
} from '@order-health/shared';
import {
  fetchFulfillmentOrders,
  fetchInventorySyncCheck,
  fetchJobQueueHealth,
  fetchMissedShipments,
  fetchNavInventory,
  fetchOrderPresence,
  fetchPendingFulfillment,
  fetchStuckStaging,
  fetchStuckStagingDuplicates,
  triggerRemediation,
  type DiagnosticEnvelope,
} from '../api';

// The unified remediation modal (UX review Session B). A signal opens to ONE modal
// with three stacked, clearly-labelled regions, in order:
//   1. WHY      - the red/amber/green reason, the numbers, the threshold.
//   2. DIAGNOSE - read-only facts pulled live and inline (loads on open, spinner
//                 then facts, degrades to "diagnostic unavailable" on error).
//   3. RESOLVE  - exactly one of: a one-click FIX (dry run first, admin-only live),
//                 an INSTRUCT step list with an OWNER chip, or (OOS-held) a per-order
//                 resolution routed by each order's NAV-join bucket.
// A plain-language mode chip heads RESOLVE ("One-click fix available", "NAV admin
// action required", "Triage by NAV bucket"), never "would trigger".
//
// Accessibility (AA): role="dialog", aria-labelledby the signal name, aria-describedby
// the WHY line; each region is a <section> with a heading; Escape closes; Tab is
// trapped inside; focus returns to the card that opened the modal.

export interface RemediationSubject {
  subjectKind: 'pipe' | 'signal' | 'order';
  subjectKey: string;
  label: string;
  detectedToolId?: string;
  detectionReason?: string;
  verdict?: Verdict;
  why?: string;
  details?: { k: string; v: string }[];
  nextStep?: string;
  orderId?: string | number;   // Shopify order id, for the read-only FO Inspector / presence reads
  diagSku?: string;            // representative SKU, for the read-only NAV inventory check
  oosHeld?: OosHeldDetail;     // the OOS-held pipe's per-order NAV-join buckets (Unit 1)
}

function verdictWord(v: Verdict | undefined): string {
  if (v === 'red') return 'red';
  if (v === 'amber') return 'amber';
  if (v === 'green') return 'green';
  return 'flagged';
}

function toolFor(registry: RemediationRegistry, toolId: string): RemediationTool | null {
  return registry.tools.find((t) => t.id === toolId) ?? null;
}

// --- Owner + mode plain-language derivation (UX review) --------------------
// The OWNER chip names who acts (you / NAV admin / IT-Symmetry / Shopify admin /
// HF1FTZ 3PL / Admin for a live write). Derived from the tool identity so the
// mapping is deterministic and testable, without a shared-type migration.
type Owner = { label: string; cls: string };
const NAV_ADMIN = new Set(['oos_held_nav_line_add', 'unblock_and_repromote', 'clear_cu50007_job', 'rerun_auto_release']);
const IT_SYMMETRY = new Set(['atomic_watcher_restart', 'allocator_reallocate', 'webhook_outcome_redrive', 'fs_refloor']);
const SHOPIFY_ADMIN = new Set(['webhook_resubscribe']);
const THREE_PL = new Set(['genuine_3pl_delay_chase']);
const OPERATOR = new Set(['oos_held_stale_clear', 'reconcile_audit', 'oos_held_triage']);

function ownerFor(tool: RemediationTool): Owner {
  if (tool.kind === 'middleware_endpoint') {
    // A read-only endpoint (reconcile_audit's check) is operator-runnable, not a write.
    if (tool.endpoint?.readOnly === true) return { label: 'You (operator)', cls: 'you' };
    return { label: 'Admin (live write)', cls: 'admin' };
  }
  if (NAV_ADMIN.has(tool.id)) return { label: 'NAV admin', cls: 'nav' };
  if (IT_SYMMETRY.has(tool.id)) return { label: 'IT / Symmetry', cls: 'it' };
  if (SHOPIFY_ADMIN.has(tool.id)) return { label: 'Shopify admin', cls: 'shopify' };
  if (THREE_PL.has(tool.id)) return { label: 'HF1FTZ 3PL', cls: 'threepl' };
  if (OPERATOR.has(tool.id)) return { label: 'You (operator)', cls: 'you' };
  return { label: 'You (operator)', cls: 'you' };
}

// The plain-words mode chip that heads RESOLVE.
function modeChip(tool: RemediationTool | null): { label: string; cls: string } {
  if (tool === null) return { label: 'No automated fix: investigate', cls: 'diagnose' };
  if (tool.kind === 'middleware_endpoint') {
    if (tool.endpoint?.readOnly === true) return { label: 'Read-only check (no changes)', cls: 'diagnose' };
    if (tool.endpoint?.heldFromLivePath === true) return { label: 'Preview only (held from live)', cls: 'diagnose' };
    return tool.endpoint?.supportsDryRun === true || tool.endpoint?.checkPath !== undefined
      ? { label: 'One-click fix available (dry run first)', cls: 'fix' }
      : { label: 'One-click fix available (live write)', cls: 'fix' };
  }
  if (tool.id === 'genuine_3pl_delay_chase') return { label: 'Diagnose then chase the 3PL', cls: 'diagnose' };
  if (tool.id === 'reconcile_audit') return { label: 'Read-only reconcile (no writes)', cls: 'diagnose' };
  if (tool.id === 'oos_held_triage') return { label: 'Triage by NAV bucket, then fix or instruct per order', cls: 'diagnose' };
  const owner = ownerFor(tool);
  return { label: `${owner.label} action required`, cls: 'instruct' };
}

// --- Per-tool DIAGNOSE reads (the "Run diagnosis" buttons) -----------------
// The HARD UI RULE: never render a raw endpoint string or a runbook filename as
// content. Instead, each tool whose diagnosis maps to a REAL middleware read gets a
// clickable "Run diagnosis" button that executes the read via the order-health
// diagnostic proxy and renders the RESULT inline. Tools whose "diagnostic" is a NAV
// SQL description or a non-existent endpoint (allocator/status, webhooks/health) get
// no button; their DIAGNOSE is the WHY + inline steps, never a dead string.
const TOOL_DIAGNOSTIC: Record<string, { label: string; load: () => Promise<DiagnosticEnvelope> }> = {
  clear_cu50007_job: { label: 'Run NAV job-queue health check', load: fetchJobQueueHealth },
  rerun_auto_release: { label: 'Run stuck-staging check', load: fetchStuckStaging },
  unblock_and_repromote: { label: 'Run stuck-staging check', load: fetchStuckStaging },
  stuck_staging_dedupe: { label: 'Preview duplicate staging rows (read-only)', load: fetchStuckStagingDuplicates },
  back_sync_run_now: { label: 'Run missed-shipments check', load: fetchMissedShipments },
  back_sync_rescan_from: { label: 'Run missed-shipments check', load: fetchMissedShipments },
  recovery_sweep: { label: 'Run pending-fulfillment check', load: fetchPendingFulfillment },
  submit_fulfillment_request: { label: 'Run pending-fulfillment check', load: fetchPendingFulfillment },
};

// Order-targeted endpoints that REQUIRE a numeric Shopify order id. For an order
// subject the subjectKey is the classification signal (e.g. 'fs_floor_at_zero'),
// NOT the id, so the id is threaded via subject.orderId; when it is absent / not
// numeric the FIX is DISABLED with a clear reason rather than firing a 0 (the 502).
const NEEDS_ORDER_ID = new Set(['forward_sync_replay', 'recovery_sweep', 'submit_fulfillment_request']);

function numericOrderId(id: string | number | undefined): string | null {
  if (id === undefined) return null;
  const s = String(id);
  return /^\d+$/.test(s) ? s : null;
}

// Compact primitive rows from an unknown diagnostic payload, so the DIAGNOSE region
// renders live facts without knowing every middleware shape. Non-primitive values
// are summarised (array length); the raw JSON is available as a fallback preview.
function primitiveRows(data: unknown): { k: string; v: string }[] {
  if (data === null || typeof data !== 'object') return [];
  const rows: { k: string; v: string }[] = [];
  for (const [k, val] of Object.entries(data as Record<string, unknown>)) {
    if (rows.length >= 12) break;
    if (val === null || ['string', 'number', 'boolean'].includes(typeof val)) rows.push({ k, v: String(val) });
    else if (Array.isArray(val)) rows.push({ k, v: `${val.length} item(s)` });
  }
  return rows;
}

// --- DIAGNOSE: one read card, loads once on open --------------------------
function DiagCard({
  title,
  load,
}: {
  title: string;
  load: () => Promise<DiagnosticEnvelope>;
}): JSX.Element {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [data, setData] = useState<unknown>(null);
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    load()
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setState('ok');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
    // load is a stable closure per subject open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = state === 'ok' ? primitiveRows(data) : [];
  return (
    <div className="rm-diag-card">
      <div className="rm-diag-hd">{title}</div>
      {state === 'loading' && (
        <div className="rm-diag-body" role="status" aria-live="polite">
          <span className="rm-spin" aria-hidden="true" /> loading diagnostics...
        </div>
      )}
      {state === 'error' && (
        <div className="rm-diag-body rm-diag-muted" role="status">
          diagnostic unavailable (the middleware read did not respond)
        </div>
      )}
      {state === 'ok' && (
        <div className="rm-diag-body">
          {rows.length > 0 ? (
            <div className="rm-kv">
              {rows.map((r) => (
                <div className="rm-kv-row" key={r.k}>
                  <span className="rm-k">{r.k}</span>
                  <span className="rm-v mono">{r.v}</span>
                </div>
              ))}
            </div>
          ) : (
            <pre className="rm-diag-json">{JSON.stringify(data, null, 2).slice(0, 700)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

type Read = { key: string; title: string; load: () => Promise<DiagnosticEnvelope> };

function readsFor(subject: RemediationSubject): Read[] {
  const reads: Read[] = [];
  const isOosHeld = subject.subjectKey === 'oos_held';
  if (isOosHeld || subject.subjectKey === 'nav_job_queue' || subject.subjectKey === 'inventory_sync') {
    reads.push({ key: 'jq', title: 'NAV job-queue health (CU 50007 / CU 50009)', load: fetchJobQueueHealth });
  }
  if (isOosHeld || subject.subjectKey === 'back_sync' || subject.subjectKey === 'missed_back_sync') {
    reads.push({ key: 'pf', title: 'Pending fulfillment requests', load: fetchPendingFulfillment });
  }
  if (subject.subjectKey === 'back_sync' || subject.subjectKey === 'missed_back_sync') {
    reads.push({ key: 'ms', title: 'Missed NAV shipments (no Shopify fulfillment)', load: fetchMissedShipments });
  }
  if (subject.subjectKey === 'nav_staging_stuck') {
    reads.push({ key: 'ss', title: 'Stuck NAV staging rows', load: fetchStuckStaging });
    reads.push({ key: 'ssd', title: 'Duplicate staging rows (dedupe preview, read-only)', load: fetchStuckStagingDuplicates });
  }
  if (subject.orderId !== undefined) {
    const id = String(subject.orderId);
    reads.push({ key: 'fo', title: 'Fulfillment orders (FO Inspector)', load: () => fetchFulfillmentOrders(id) });
    reads.push({ key: 'op', title: 'NAV order presence', load: () => fetchOrderPresence(id) });
  }
  if (subject.diagSku !== undefined && subject.diagSku.length > 0) {
    const sku = subject.diagSku;
    reads.push({ key: 'inv', title: `NAV inventory check (${sku})`, load: () => fetchNavInventory(sku) });
  }
  return reads;
}

// Bucket tallies for the OOS-held pipe, from the joined snapshot detail (WI3).
function OosHeldBuckets({ detail }: { detail: OosHeldDetail }): JSX.Element {
  const rows: { k: string; v: string }[] = [
    { k: 'Total held', v: String(detail.total_count ?? 'n/a') },
    { k: 'Alerting (transient, unresolved)', v: String(detail.alerting_count ?? 'n/a') },
    { k: 'Needs operator', v: String(detail.needs_operator_count ?? 'n/a') },
    { k: 'Backorder (legitimate)', v: String(detail.backorder_count ?? 'n/a') },
    { k: 'Not in NAV (re-drive)', v: String(detail.not_in_nav_count ?? 'not joined') },
    { k: 'In NAV, line missing (NAV admin)', v: String(detail.in_nav_line_missing_count ?? 'not joined') },
    { k: 'In NAV, line present (stale / replay)', v: String(detail.in_nav_line_present_count ?? 'not joined') },
  ];
  return (
    <div className="rm-diag-card">
      <div className="rm-diag-hd">OOS-held backlog by NAV-join bucket</div>
      <div className="rm-diag-body">
        <div className="rm-kv">
          {rows.map((r) => (
            <div className="rm-kv-row" key={r.k}>
              <span className="rm-k">{r.k}</span>
              <span className="rm-v mono">{r.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DiagnoseRegion({ subject }: { subject: RemediationSubject }): JSX.Element {
  const reads = useMemo(() => readsFor(subject), [subject]);
  const hasBuckets = subject.oosHeld !== undefined;
  if (!hasBuckets && reads.length === 0) {
    return <p className="rm-diag-muted">No inline diagnostics for this signal. The WHY above is the read.</p>;
  }
  return (
    <div className="rm-diag">
      {hasBuckets && <OosHeldBuckets detail={subject.oosHeld as OosHeldDetail} />}
      {reads.map((r) => (
        <DiagCard key={r.key} title={r.title} load={r.load} />
      ))}
    </div>
  );
}

// --- RESOLVE: the exact call an operator authorises (two-step confirm) ------
function ConfirmPanel({
  tool,
  live,
  orderId,
  paramValues,
  busy,
  onConfirm,
  onCancel,
}: {
  tool: RemediationTool;
  live: boolean;
  orderId?: string | null;
  paramValues?: Record<string, string>;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const ep = tool.endpoint;
  const gated = ep?.gated === true;
  const params = ep?.params ?? [];
  // HARD UI RULE (Correction 5): show the HUMAN action name and its parameters,
  // never a raw endpoint string / method + path.
  return (
    <div className="rm-confirm" role="group" aria-label="Confirm and run">
      <div className="rm-confirm-hd">{live ? 'Confirm live write' : 'Confirm and run'}</div>
      <p className="rm-confirm-lead">
        {live
          ? 'This writes to NAV / Shopify via the middleware. It runs only if remediation is armed on the server; otherwise the server returns a disarmed preview.'
          : 'This authorises the action below. It runs only if remediation is armed on the server.'}
      </p>
      <div className="rm-confirm-rows">
        <div className="rm-cf-row">
          <span className="rm-k">Action</span>
          <span className="rm-v">{tool.name}</span>
        </div>
        {orderId !== undefined && orderId !== null && (
          <div className="rm-cf-row">
            <span className="rm-k">Target order</span>
            <span className="rm-v mono">{orderId}</span>
          </div>
        )}
        {params.map((p) => (
          <div className="rm-cf-row" key={p.name}>
            <span className="rm-k">{p.label}</span>
            <span className="rm-v mono">{paramValues?.[p.name] ?? ''}</span>
          </div>
        ))}
        <div className="rm-cf-row">
          <span className="rm-k">Auth</span>
          <span className="rm-v mono">set_by=order-health-operator{gated ? ' + NAV_TOGGLE_PASSWORD' : ''}</span>
        </div>
      </div>
      <div className="rm-actions">
        <button className={`rm-btn ${live ? 'rm-live' : ''}`} onClick={onConfirm} disabled={busy}>
          {busy ? 'Running...' : live ? 'Confirm live write' : 'Confirm and run'}
        </button>
        <button className="rm-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Resolve a tool's declared params into initial values: a locked constant (fixed),
// the order/signal-sourced value (source), a prefilled editable default, or empty
// (prompted). Fixed params are not operator-editable; the rest render as inputs.
function initialParamValues(
  params: readonly RemediationParam[],
  orderSku?: string,
  orderId?: string | number,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const p of params) {
    if (p.fixed !== undefined) {
      values[p.name] = p.fixed;
      continue;
    }
    const sourced =
      p.source === 'order_sku'
        ? orderSku ?? ''
        : p.source === 'order_id'
          ? orderId !== undefined
            ? String(orderId)
            : ''
          : '';
    values[p.name] = sourced || p.default || '';
  }
  return values;
}

// The labelled param inputs (Correction 3): auto-filled from data when available,
// otherwise a prompted input; fixed params are shown locked. A required-but-empty
// param disables the Run button (enforced by the caller via missingRequired).
function ParamFields({
  params,
  values,
  onChange,
  disabled,
}: {
  params: readonly RemediationParam[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  disabled: boolean;
}): JSX.Element | null {
  if (params.length === 0) return null;
  return (
    <div className="rm-params">
      {params.map((p) => {
        const locked = p.fixed !== undefined;
        const id = `rm-param-${p.name}`;
        return (
          <label className="rm-param" key={p.name} htmlFor={id}>
            <span className="rm-param-l">
              {p.label}
              {p.required && <span className="rm-param-req" aria-hidden="true"> *</span>}
            </span>
            <input
              id={id}
              className="rm-param-in"
              type="text"
              value={values[p.name] ?? ''}
              readOnly={locked}
              disabled={disabled || locked}
              onChange={(e) => onChange(p.name, e.target.value)}
              aria-label={p.label}
            />
          </label>
        );
      })}
    </div>
  );
}

// The FIX affordance for a callable middleware endpoint: dry-run first where the
// endpoint supports it, a separate visually-heavier live write disabled until a dry
// run has been previewed, admin-only for the live write. Endpoints with no dry_run
// flag (recovery / forward-sync / back-sync) offer only the live write (two-step
// confirm), still admin-only.
function LiveAction({
  tool,
  subjectKind,
  subjectKey,
  isAdmin,
  shopifyOrderId,
  orderSku,
}: {
  tool: RemediationTool;
  subjectKind: 'pipe' | 'signal' | 'order';
  subjectKey: string;
  isAdmin: boolean;
  shopifyOrderId?: string | number;
  orderSku?: string;
}): JSX.Element {
  const ep = tool.endpoint;
  const params = ep?.params ?? [];
  const [busy, setBusy] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<RemediationTriggerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>(() =>
    initialParamValues(params, orderSku, shopifyOrderId),
  );
  // The read-only check (dry run preview via check, and the reconcile Run) state.
  const [checkState, setCheckState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [checkData, setCheckData] = useState<unknown>(null);

  const held = ep?.heldFromLivePath === true;
  const readOnly = ep?.readOnly === true;
  const supportsDryRun = ep?.supportsDryRun === true;
  const hasCheck = ep?.checkPath !== undefined;
  const hasPreview = hasCheck || supportsDryRun;

  // Order-targeted fixes need the NUMERIC Shopify id. When it is absent / not numeric
  // the FIX is DISABLED with a clear reason: we never fire a 0 (which 502-ed the
  // middleware). subjectKey for an order is the classification signal, not the id.
  const numericId = numericOrderId(shopifyOrderId);
  const idMissing = NEEDS_ORDER_ID.has(tool.id) && numericId === null;
  // A required param with no value disables the fire (Correction 3): never a zero/blank.
  const missingRequired = params.some((p) => p.required && (paramValues[p.name] ?? '').trim().length === 0);

  function setParam(name: string, value: string): void {
    setParamValues((prev) => ({ ...prev, [name]: value }));
    // Editing a param invalidates a prior preview so the operator re-checks.
    setPreviewed(false);
    setCheckState('idle');
  }

  // The read-only inventory-sync/check: the reconcile Run and the Holman-release dry
  // run. Executes the proxy (no write) and shows the NAV vs Shopify vs would_set delta.
  async function runCheck(): Promise<void> {
    setCheckState('loading');
    setError(null);
    try {
      const res = await fetchInventorySyncCheck(
        paramValues.sku ?? '',
        paramValues.location_code,
        paramValues.channel,
      );
      setCheckData(res.data);
      setCheckState('ok');
      setPreviewed(true);
    } catch {
      setCheckState('error');
    }
  }

  async function fire(dryRun: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await triggerRemediation(
        tool.id,
        { subjectKind, subjectKey },
        true,
        dryRun,
        numericId ?? undefined,
        params.length > 0 ? paramValues : undefined,
      );
      setResult(res);
      if (dryRun) setPreviewed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'trigger failed');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (idMissing) {
    return (
      <p className="rm-when rm-err">
        This fix targets a specific Shopify order, but no numeric Shopify order id is available for this
        item (its id is a classification or a split order name). Open the fix from the individual order so its
        Shopify id is carried, or resolve it another way; the fix is disabled here so it cannot fire against
        order 0.
      </p>
    );
  }

  const checkResult = (
    <>
      {checkState === 'error' && (
        <div className="rm-diag-body rm-diag-muted" role="status">
          check unavailable (the middleware read did not respond)
        </div>
      )}
      {checkState === 'ok' && (
        <div className="rm-diag-body" role="status" aria-live="polite">
          <div className="rm-kv">
            {primitiveRows(checkData).map((r) => (
              <div className="rm-kv-row" key={r.k}>
                <span className="rm-k">{r.k}</span>
                <span className="rm-v mono">{r.v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );

  // READ-ONLY tool (reconcile_audit): a single Run that executes the check and shows
  // the delta inline. No live write, no confirm; operators may run it.
  if (readOnly) {
    return (
      <>
        <ParamFields params={params} values={paramValues} onChange={setParam} disabled={checkState === 'loading'} />
        <div className="rm-actions">
          <button
            className="rm-btn"
            onClick={() => void runCheck()}
            disabled={checkState === 'loading' || missingRequired}
            title={missingRequired ? 'Fill the required fields first' : 'Read-only, no changes'}
          >
            {checkState === 'loading' ? 'Running...' : 'Run reconcile (read-only, no changes)'}
          </button>
        </div>
        {checkResult}
      </>
    );
  }

  if (confirming) {
    return (
      <ConfirmPanel
        tool={tool}
        live={!held}
        orderId={numericId}
        paramValues={paramValues}
        busy={busy}
        onConfirm={() => void fire(false)}
        onCancel={() => setConfirming(false)}
      />
    );
  }

  const liveDisabled = !isAdmin || busy || missingRequired || (hasPreview && !previewed);
  const liveTitle = !isAdmin
    ? 'Admin only'
    : missingRequired
      ? 'Fill the required fields first'
      : hasPreview && !previewed
        ? 'Run a dry run first'
        : 'Writes to NAV / Shopify';

  return (
    <>
      <ParamFields params={params} values={paramValues} onChange={setParam} disabled={busy} />
      <div className="rm-actions">
        {held ? (
          <button className="rm-btn" onClick={() => void fire(true)} disabled={busy}>
            {busy ? 'Running...' : 'Preview (no live call)'}
          </button>
        ) : (
          <>
            {hasCheck ? (
              <button
                className="rm-btn"
                onClick={() => void runCheck()}
                disabled={checkState === 'loading' || missingRequired}
              >
                {checkState === 'loading' ? 'Running...' : 'Dry run (preview via check)'}
              </button>
            ) : (
              supportsDryRun && (
                <button className="rm-btn" onClick={() => void fire(true)} disabled={busy || missingRequired}>
                  {busy ? 'Running...' : 'Dry run (preview, no changes)'}
                </button>
              )
            )}
            <button
              className="rm-btn rm-live"
              onClick={() => setConfirming(true)}
              disabled={liveDisabled}
              title={liveTitle}
              aria-label={
                !isAdmin
                  ? 'Run live, Admin only'
                  : hasPreview && !previewed
                    ? 'Run live, disabled until dry run'
                    : 'Run live write'
              }
            >
              Run live
            </button>
          </>
        )}
      </div>
      {hasCheck && checkResult}
      {!isAdmin && !held && <p className="rm-when">Live write is Admin only; you may run the dry run / preview.</p>}
      {error !== null && <div className="rm-err">{error}</div>}
      {result !== null && (
        <div className="rm-result" role="status">
          <span className={`rm-result-badge s-${result.status}`}>
            {result.status === 'triggered' ? 'ran live' : result.status === 'error' ? 'failed' : 'preview only'}
          </span>
          <p className="rm-result-msg">{result.message}</p>
          {result.status === 'error' && result.error !== undefined && <div className="rm-err">{result.error}</div>}
        </div>
      )}
    </>
  );
}

// One RESOLVE card for a single tool: FIX (LiveAction) for callable endpoints, or
// INSTRUCT (owner chip + numbered steps + diagnosis, no fire button) for ops tools.
function ResolveCard({
  mapping,
  tool,
  subject,
  isAdmin,
  recommended,
  detectionReason,
}: {
  mapping: RemediationMapping;
  tool: RemediationTool;
  subject: RemediationSubject;
  isAdmin: boolean;
  recommended: boolean;
  detectionReason?: string;
}): JSX.Element {
  const owner = ownerFor(tool);
  const isEndpoint = tool.kind === 'middleware_endpoint';
  return (
    <div className="rm-tool">
      <div className="rm-tool-hd">
        <div>
          <div className="rm-kicker">{recommended ? 'Recommended' : 'Alternative'}</div>
          <h4>{tool.name}</h4>
        </div>
        <div className="rm-tool-tags">
          <span className={`rm-owner o-${owner.cls}`}>{owner.label}</span>
          <span className={`rm-kind ${tool.writeCapable ? 'w' : 'r'}`}>
            {isEndpoint ? 'existing endpoint' : 'ops runbook'}
            {tool.writeCapable ? '' : ' · read-only'}
          </span>
        </div>
      </div>
      <p className="rm-desc">{tool.description}</p>
      {recommended && detectionReason !== undefined && <p className="rm-when">Detected: {detectionReason}</p>}
      <p className="rm-when">Applies when: {mapping.appliesWhen}</p>
      {tool.steps !== undefined && tool.steps.length > 0 && (
        <ol className="rm-steps">
          {tool.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {/* DIAGNOSE: a clickable "Run diagnosis" that executes the read via the proxy
          and renders the RESULT inline. Never a raw endpoint string / filename. */}
      {TOOL_DIAGNOSTIC[tool.id] !== undefined && (
        <RunDiagnosis label={TOOL_DIAGNOSTIC[tool.id]!.label} load={TOOL_DIAGNOSTIC[tool.id]!.load} />
      )}
      {isEndpoint ? (
        <LiveAction
          tool={tool}
          subjectKind={subject.subjectKind}
          subjectKey={subject.subjectKey}
          isAdmin={isAdmin}
          shopifyOrderId={subject.orderId}
          orderSku={subject.diagSku}
        />
      ) : (
        <p className="rm-instruct-note">Owner: {owner.label}. No API call: follow the numbered steps above by hand.</p>
      )}
    </div>
  );
}

// A single "Run diagnosis" button that executes a read-only middleware proxy read
// on demand and renders the RESULT inline (facts, not a raw endpoint string). Used
// in RESOLVE beside a tool whose diagnosis maps to a real middleware read.
function RunDiagnosis({
  label,
  load,
}: {
  label: string;
  load: () => Promise<DiagnosticEnvelope>;
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [data, setData] = useState<unknown>(null);
  async function run(): Promise<void> {
    setState('loading');
    try {
      const res = await load();
      setData(res.data);
      setState('ok');
    } catch {
      setState('error');
    }
  }
  const rows = state === 'ok' ? primitiveRows(data) : [];
  return (
    <div className="rm-rundiag">
      <button className="rm-btn ghost sm" onClick={() => void run()} disabled={state === 'loading'}>
        {state === 'loading' ? 'Running diagnosis...' : label}
      </button>
      {state === 'error' && (
        <div className="rm-diag-body rm-diag-muted" role="status">
          diagnostic unavailable (the middleware read did not respond)
        </div>
      )}
      {state === 'ok' && (
        <div className="rm-diag-body" role="status" aria-live="polite">
          {rows.length > 0 ? (
            <div className="rm-kv">
              {rows.map((r) => (
                <div className="rm-kv-row" key={r.k}>
                  <span className="rm-k">{r.k}</span>
                  <span className="rm-v mono">{r.v}</span>
                </div>
              ))}
            </div>
          ) : (
            <pre className="rm-diag-json">{JSON.stringify(data, null, 2).slice(0, 700)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// The bucket label + per-order presence check for the OOS-held per-order resolution.
const BUCKET_LABEL: Record<string, string> = {
  not_in_nav: 'Not in NAV: re-drive',
  in_nav_line_missing: 'In NAV, line missing: NAV admin',
  in_nav_line_present: 'In NAV, line present: stale / replay',
};

function OrderPresenceCheck({ orderId }: { orderId: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [data, setData] = useState<unknown>(null);
  async function run(): Promise<void> {
    setState('loading');
    try {
      const res = await fetchOrderPresence(orderId);
      setData(res.data);
      setState('ok');
    } catch {
      setState('error');
    }
  }
  return (
    <div className="rm-presence">
      <button className="rm-btn ghost sm" onClick={() => void run()} disabled={state === 'loading'}>
        {state === 'loading' ? 'Checking...' : 'Check NAV presence'}
      </button>
      {state === 'ok' && <span className="rm-presence-out mono">{JSON.stringify(data).slice(0, 160)}</span>}
      {state === 'error' && <span className="rm-presence-out rm-diag-muted">presence read unavailable</span>}
    </div>
  );
}

// OOS-held RESOLVE: one row per held order, routed by its NAV-join bucket. not_in_nav
// -> a re-drive FIX (forward-sync replay, admin-only live). in_nav_line_missing ->
// INSTRUCT (add the dropped NAV line by hand, NAV admin). in_nav_line_present ->
// INSTRUCT stale-clear (you) plus a recovery-replay FIX if the fulfillment never
// fired. A blanket re-drive is wrong: it DuplicateSkips every in-NAV order.
function OosHeldResolve({
  detail,
  registry,
  isAdmin,
}: {
  detail: OosHeldDetail;
  registry: RemediationRegistry;
  isAdmin: boolean;
}): JSX.Element {
  const CAP = 20;
  const orders = detail.held_orders.slice(0, CAP);
  const hidden = detail.held_orders.length - orders.length;
  const holman = toolFor(registry, 'oos_held_inventory_push');
  const forwardReplay = toolFor(registry, 'forward_sync_replay');
  const recovery = toolFor(registry, 'recovery_sweep');
  const lineAdd = toolFor(registry, 'oos_held_nav_line_add');
  const staleClear = toolFor(registry, 'oos_held_stale_clear');

  function renderOrder(o: OosHeldOrder): JSX.Element {
    const bucket = o.nav_bucket;
    const name = o.order_name ?? o.order_id ?? 'order';
    const owner =
      bucket === 'in_nav_line_missing'
        ? { label: 'NAV admin', cls: 'nav' }
        : bucket === 'not_in_nav'
          ? { label: 'Admin (live write)', cls: 'admin' }
          : { label: 'You (operator)', cls: 'you' };
    return (
      <div className="rm-order" key={`${o.order_id ?? name}`}>
        <div className="rm-order-hd">
          <span className="rm-order-nm mono">{name}</span>
          <span className={`rm-bucket b-${bucket ?? 'unknown'}`}>{bucket ? BUCKET_LABEL[bucket] : 'not joined'}</span>
          <span className={`rm-owner o-${owner.cls}`}>{owner.label}</span>
        </div>
        {o.last_detail !== null && <p className="rm-when">Last: {o.last_detail}</p>}
        {o.order_id !== null && <OrderPresenceCheck orderId={o.order_id} />}
        {/* Correction 1: the PRIMARY fix for every held order is the Holman inventory
            release (dry-run check at HF1FTZ, then push NAV on-hand to Shopify). The
            SKU auto-fills from the held order (sample_sku) or is prompted. */}
        {holman !== null && (
          <div className="rm-order-fix">
            <div className="rm-kicker">Primary fix</div>
            <LiveAction
              tool={holman}
              subjectKind="order"
              subjectKey={o.order_id ?? ''}
              isAdmin={isAdmin}
              shopifyOrderId={o.order_id ?? undefined}
              orderSku={o.sample_sku ?? undefined}
            />
          </div>
        )}
        {bucket === 'not_in_nav' && forwardReplay !== null && (
          <div className="rm-order-fix">
            <div className="rm-kicker">Secondary: re-drive (order not in NAV)</div>
            <LiveAction
              tool={forwardReplay}
              subjectKind="order"
              subjectKey={o.order_id ?? ''}
              isAdmin={isAdmin}
              shopifyOrderId={o.order_id ?? undefined}
            />
          </div>
        )}
        {bucket === 'in_nav_line_missing' && lineAdd !== null && (
          <div className="rm-instruct">
            <ol className="rm-steps">{(lineAdd.steps ?? []).map((s, i) => <li key={i}>{s}</li>)}</ol>
            <p className="rm-when">{lineAdd.runbook?.command}</p>
            <p className="rm-instruct-note">Owner: NAV admin. Do NOT forward-sync replay (it DuplicateSkips).</p>
          </div>
        )}
        {bucket === 'in_nav_line_present' && (
          <div className="rm-instruct">
            {staleClear !== null && (
              <>
                <ol className="rm-steps">{(staleClear.steps ?? []).map((s, i) => <li key={i}>{s}</li>)}</ol>
                <p className="rm-when">{staleClear.runbook?.command}</p>
              </>
            )}
            {recovery !== null && (
              <>
                <p className="rm-when">If the NAV shipment posted but the Shopify fulfillment never fired, replay it:</p>
                <LiveAction
                  tool={recovery}
                  subjectKind="order"
                  subjectKey={o.order_id ?? ''}
                  isAdmin={isAdmin}
                  shopifyOrderId={o.order_id ?? undefined}
                />
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rm-orders">
      {orders.map(renderOrder)}
      {orders.length === 0 && <p className="rm-diag-muted">No individual held orders in this snapshot.</p>}
      {hidden > 0 && <p className="rm-when">{hidden} more held order(s) not shown; work the buckets above first.</p>}
    </div>
  );
}

export function RemediationModal({
  subject,
  registry,
  isAdmin,
  onClose,
}: {
  subject: RemediationSubject | null;
  registry: RemediationRegistry | null;
  isAdmin: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // The mapped tools for this subject, recommended first (detected tool, else the
  // static primary). Used by the RESOLVE region for non-OOS-held subjects.
  const cards = useMemo(() => {
    if (subject === null || registry === null) return [];
    const mapped = registry.mappings
      .filter((m) => m.subjectKey === subject.subjectKey)
      .map((m) => ({ mapping: m, tool: toolFor(registry, m.toolId) }))
      .filter((x): x is { mapping: RemediationMapping; tool: RemediationTool } => x.tool !== null);
    const staticPrimaryId = mapped.find((c) => c.mapping.primary)?.tool.id ?? null;
    const recommendedId = subject.detectedToolId ?? staticPrimaryId;
    return mapped
      .map((c) => ({ ...c, recommended: c.tool.id === recommendedId }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended));
  }, [subject, registry]);

  const headTool = cards.find((c) => c.recommended)?.tool ?? null;
  const isOosHeldPipe = subject?.subjectKey === 'oos_held' && subject.oosHeld !== undefined;
  // Correction 4: when the subject is green/healthy there is nothing to fix, so the
  // RESOLVE actions are suppressed and the mode chip says so. DIAGNOSE stays open so
  // a healthy signal can still be inspected (a green card is still openable).
  const isHealthy = subject?.verdict === 'green';
  const mode = isHealthy
    ? { label: 'Healthy: no remediation needed', cls: 'healthy' }
    : isOosHeldPipe
      ? { label: 'Triage by NAV bucket, then fix or instruct per order', cls: 'diagnose' }
      : modeChip(headTool);

  // Focus management: capture the opener, focus the close button on open, return
  // focus to the opener on close.
  useEffect(() => {
    if (subject !== null) {
      openerRef.current = document.activeElement as HTMLElement | null;
      closeRef.current?.focus();
    } else if (openerRef.current !== null) {
      openerRef.current.focus();
      openerRef.current = null;
    }
  }, [subject]);

  // Escape closes; Tab is trapped within the dialog's focusable controls.
  useEffect(() => {
    if (subject === null) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (root === null) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [subject, onClose]);

  if (subject === null || registry === null) return null;
  const word = verdictWord(subject.verdict);

  return (
    <div className="rm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="rm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-title"
        aria-describedby={subject.why !== undefined ? 'rm-why-text' : undefined}
        ref={dialogRef}
      >
        <div className="rm-mh">
          <h3 id="rm-title">{subject.label}</h3>
          <button className="rm-x" ref={closeRef} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="rm-mb">
          {/* WHY */}
          <section className="rm-section" aria-labelledby="rm-why-h">
            <h4 id="rm-why-h" className="rm-sec-h">
              Why this is {word}
            </h4>
            <div className={`rm-why v-${word}`}>
              <p className="rm-why-text" id="rm-why-text">
                {subject.why ?? `${subject.label} - ${word}`}
              </p>
              {subject.details !== undefined && subject.details.length > 0 && (
                <div className="rm-why-rows">
                  {subject.details.map((d) => (
                    <div className="rm-why-row" key={d.k}>
                      <span className="rm-k">{d.k}</span>
                      <span className="rm-v">{d.v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* DIAGNOSE */}
          <section className="rm-section" aria-labelledby="rm-diag-h">
            <h4 id="rm-diag-h" className="rm-sec-h">
              Diagnose
            </h4>
            <DiagnoseRegion subject={subject} />
          </section>

          {/* RESOLVE */}
          <section className="rm-section" aria-labelledby="rm-resolve-h">
            <h4 id="rm-resolve-h" className="rm-sec-h">
              Resolve
            </h4>
            <div className={`rm-mode ${mode.cls}`}>{mode.label}</div>
            {isHealthy ? (
              <div className="rm-healthy" role="status">
                <p className="rm-desc">
                  This signal is healthy (green), so there is nothing to remediate. The read-only
                  Diagnose section above stays available if you want to inspect it or run a dry-run check.
                </p>
              </div>
            ) : isOosHeldPipe ? (
              <OosHeldResolve detail={subject.oosHeld as OosHeldDetail} registry={registry} isAdmin={isAdmin} />
            ) : cards.length === 0 ? (
              <div className="rm-nostep">
                <p className="rm-desc">No automated remediation tool is mapped for this item.</p>
                <p className="rm-when">
                  Next step:{' '}
                  {subject.nextStep ??
                    'investigate the item above and hand it to the owning team; nothing here can be triggered.'}
                </p>
              </div>
            ) : (
              cards.map(({ mapping, tool, recommended }) => (
                <ResolveCard
                  key={tool.id}
                  mapping={mapping}
                  tool={tool}
                  subject={subject}
                  isAdmin={isAdmin}
                  recommended={recommended}
                  detectionReason={
                    recommended && tool.id === subject.detectedToolId ? subject.detectionReason : undefined
                  }
                />
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
