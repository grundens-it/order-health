import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  OosHeldDetail,
  OosHeldOrder,
  RemediationMapping,
  RemediationRegistry,
  RemediationTool,
  RemediationTriggerResult,
  Verdict,
} from '@order-health/shared';
import {
  fetchFulfillmentOrders,
  fetchJobQueueHealth,
  fetchNavInventory,
  fetchOrderPresence,
  fetchPendingFulfillment,
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
  if (tool.kind === 'middleware_endpoint') return { label: 'Admin (live write)', cls: 'admin' };
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
    if (tool.endpoint?.heldFromLivePath === true) return { label: 'Preview only (held from live)', cls: 'diagnose' };
    return tool.endpoint?.supportsDryRun === true
      ? { label: 'One-click fix available (dry run first)', cls: 'fix' }
      : { label: 'One-click fix available (live write)', cls: 'fix' };
  }
  if (tool.id === 'genuine_3pl_delay_chase') return { label: 'Diagnose then chase the 3PL', cls: 'diagnose' };
  if (tool.id === 'reconcile_audit') return { label: 'Read-only reconcile (no writes)', cls: 'diagnose' };
  if (tool.id === 'oos_held_triage') return { label: 'Triage by NAV bucket, then fix or instruct per order', cls: 'diagnose' };
  const owner = ownerFor(tool);
  return { label: `${owner.label} action required`, cls: 'instruct' };
}

function callShape(tool: RemediationTool): string {
  if (tool.kind === 'middleware_endpoint' && tool.endpoint) {
    return `${tool.endpoint.method} ${tool.endpoint.path}  (${tool.endpoint.source})`;
  }
  if (tool.runbook) {
    const diag = tool.runbook.diagnostic ? `diagnose: ${tool.runbook.diagnostic}\n` : '';
    return `${diag}runbook ${tool.runbook.ref}${tool.runbook.command ? `\n${tool.runbook.command}` : ''}`;
  }
  return '';
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
  if (isOosHeld || subject.subjectKey === 'nav_job_queue') {
    reads.push({ key: 'jq', title: 'NAV job-queue health (CU 50007 / CU 50009)', load: fetchJobQueueHealth });
  }
  if (isOosHeld || subject.subjectKey === 'back_sync') {
    reads.push({ key: 'pf', title: 'Pending fulfillment requests', load: fetchPendingFulfillment });
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
  busy,
  onConfirm,
  onCancel,
}: {
  tool: RemediationTool;
  live: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const ep = tool.endpoint;
  const gated = ep?.gated === true;
  return (
    <div className="rm-confirm" role="group" aria-label="Confirm and run">
      <div className="rm-confirm-hd">{live ? 'Confirm live write' : 'Confirm and run'}</div>
      <p className="rm-confirm-lead">
        {live
          ? 'This writes to NAV / Shopify via the middleware. It runs only if remediation is armed on the server; otherwise the server returns a disarmed preview.'
          : 'This authorises the exact call below. It runs only if remediation is armed on the server.'}
      </p>
      <div className="rm-confirm-rows">
        <div className="rm-cf-row">
          <span className="rm-k">Call</span>
          <span className="rm-v mono">{ep ? `${ep.method} ${ep.path}` : tool.runbook?.ref ?? 'ops runbook'}</span>
        </div>
        <div className="rm-cf-row">
          <span className="rm-k">Params</span>
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
}: {
  tool: RemediationTool;
  subjectKind: 'pipe' | 'signal' | 'order';
  subjectKey: string;
  isAdmin: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<RemediationTriggerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ep = tool.endpoint;
  const held = ep?.heldFromLivePath === true;
  const supportsDryRun = ep?.supportsDryRun === true;

  async function fire(dryRun: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await triggerRemediation(tool.id, { subjectKind, subjectKey }, true, dryRun);
      setResult(res);
      if (dryRun) setPreviewed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'trigger failed');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <ConfirmPanel
        tool={tool}
        live={!held}
        busy={busy}
        onConfirm={() => void fire(false)}
        onCancel={() => setConfirming(false)}
      />
    );
  }

  const liveDisabled = !isAdmin || busy || (supportsDryRun && !previewed);
  const liveTitle = !isAdmin
    ? 'Admin only'
    : supportsDryRun && !previewed
      ? 'Run a dry run first'
      : 'Writes to NAV / Shopify';

  return (
    <>
      <div className="rm-actions">
        {held ? (
          <button className="rm-btn" onClick={() => void fire(true)} disabled={busy}>
            {busy ? 'Running...' : 'Preview (no live call)'}
          </button>
        ) : (
          <>
            {supportsDryRun && (
              <button className="rm-btn" onClick={() => void fire(true)} disabled={busy}>
                {busy ? 'Running...' : 'Dry run (preview, no changes)'}
              </button>
            )}
            <button
              className="rm-btn rm-live"
              onClick={() => setConfirming(true)}
              disabled={liveDisabled}
              title={liveTitle}
              aria-label={
                !isAdmin
                  ? 'Run live, Admin only'
                  : supportsDryRun && !previewed
                    ? 'Run live, disabled until dry run'
                    : 'Run live write'
              }
            >
              Run live
            </button>
          </>
        )}
      </div>
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
      {tool.runbook?.diagnostic !== undefined && <p className="rm-when">Diagnosis: {tool.runbook.diagnostic}</p>}
      <pre className="rm-call">{callShape(tool)}</pre>
      {isEndpoint ? (
        <LiveAction tool={tool} subjectKind={subject.subjectKind} subjectKey={subject.subjectKey} isAdmin={isAdmin} />
      ) : (
        <p className="rm-instruct-note">Owner: {owner.label}. No API call: follow the steps above by hand.</p>
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
        {bucket === 'not_in_nav' && forwardReplay !== null && (
          <LiveAction tool={forwardReplay} subjectKind="order" subjectKey={o.order_id ?? ''} isAdmin={isAdmin} />
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
                <LiveAction tool={recovery} subjectKind="order" subjectKey={o.order_id ?? ''} isAdmin={isAdmin} />
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
  const mode = isOosHeldPipe
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
            {isOosHeldPipe ? (
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
