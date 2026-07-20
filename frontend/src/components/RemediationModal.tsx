import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  RemediationMapping,
  RemediationRegistry,
  RemediationTool,
  RemediationTriggerResult,
  Verdict,
} from '@order-health/shared';
import { triggerRemediation } from '../api';

// The error-to-remediation MODAL (Unit 7, design.md 5A.4, matching the demo).
// Clicking a RED signal opens this modal; it names the mapped tool(s), describes
// the fix and its existing endpoint / ops runbook, and offers an operator
// "Trigger" button. The trigger routes to the STUBBED backend client and shows
// the typed "would trigger" result. No live call is made in v1.
//
// Accessibility: dialog role, labelled, Escape closes, a focus trap keeps Tab
// inside the modal, and focus returns to the opener. No native alert/confirm.

export interface RemediationSubject {
  subjectKind: 'pipe' | 'signal' | 'order';
  subjectKey: string;
  label: string; // human label for the header (for example the pipe display name)
  // Failure-mode detection (issue #35): when the opener observed a runtime failure
  // mode, it names the detected tool here and why. The modal marks THAT tool
  // "Recommended" (overriding the static primary) and shows the reason. Absent =>
  // fall back to the static primary mapping.
  detectedToolId?: string;
  detectionReason?: string;
  // Round 3 (Unit 4): the HEALTH reason, so the modal always explains WHY first.
  // The opener builds these from the subject's verdict + detail (pipe: the failing
  // sub-verdict + numbers + threshold; order: stage + age + the FS classification).
  verdict?: Verdict;                     // the subject's verdict (red / amber / ...)
  why?: string;                          // one-line "why this is red/amber"
  details?: { k: string; v: string }[]; // supporting numbers (age, FS available, threshold, ...)
  nextStep?: string;                     // a plain next step, shown when no tool is mapped
  orderId?: string | number;             // Shopify order id, for the read-only FO Inspector diagnostic
  diagSku?: string;                      // representative SKU, for the read-only NAV inventory check
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

// The exact call an operator is about to authorise, spelled out for the two-step
// confirm (method / path / target / params). No native confirm() is ever used.
function ConfirmPanel({
  tool,
  subject,
  busy,
  onConfirm,
  onCancel,
}: {
  tool: RemediationTool;
  subject: RemediationSubject;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const ep = tool.endpoint;
  const held = ep?.heldFromLivePath === true;
  const gated = ep?.gated === true;
  return (
    <div className="rm-confirm" role="group" aria-label="Confirm and run">
      <div className="rm-confirm-hd">Confirm and run</div>
      <p className="rm-confirm-lead">
        This authorises the exact call below. It runs only if remediation is armed on
        the server; otherwise the server returns a disarmed preview and makes no live call.
      </p>
      <div className="rm-confirm-rows">
        <div className="rm-why-row">
          <span className="rm-k">Method</span>
          <span className="rm-v mono">{ep ? ep.method : 'ops runbook (no live call)'}</span>
        </div>
        <div className="rm-why-row">
          <span className="rm-k">Path</span>
          <span className="rm-v mono">{ep ? ep.path : tool.runbook?.ref ?? '—'}</span>
        </div>
        <div className="rm-why-row">
          <span className="rm-k">Target</span>
          <span className="rm-v mono">
            {subject.subjectKind}:{subject.subjectKey}
          </span>
        </div>
        <div className="rm-why-row">
          <span className="rm-k">Params</span>
          <span className="rm-v mono">
            set_by=order-health-operator{gated ? ' + NAV_TOGGLE_PASSWORD (write-gate)' : ''}
          </span>
        </div>
      </div>
      {held && (
        <div className="rm-err">
          Held out of the live path: {ep?.heldReason ?? 'destructive action, no rollback'}. This
          returns a preview only and never fires.
        </div>
      )}
      <div className="rm-actions">
        <button className="rm-btn" onClick={onConfirm} disabled={busy}>
          {busy ? 'Running...' : 'Confirm and run'}
        </button>
        <button className="rm-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ToolCard({
  mapping,
  tool,
  subject,
  recommended,
  detectionReason,
  onResult,
}: {
  mapping: RemediationMapping;
  tool: RemediationTool;
  subject: RemediationSubject;
  recommended: boolean;      // marked "Recommended" (detected tool, or static primary)
  detectionReason?: string;  // set only on the failure-mode-detected recommended card
  onResult: (r: RemediationTriggerResult) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step confirm: the first click arms this card's Confirm panel; only the
  // explicit "Confirm and run" click POSTs with confirmed:true (ADR-0010).
  const [confirming, setConfirming] = useState(false);

  async function onConfirmRun(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await triggerRemediation(
        tool.id,
        { subjectKind: subject.subjectKind, subjectKey: subject.subjectKey },
        true, // confirmed: this is the explicit second-step sign-off
      );
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'trigger failed');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="rm-tool">
      <div className="rm-tool-hd">
        <div>
          <div className="rm-kicker">{recommended ? 'Recommended tool' : 'Alternative'}</div>
          <h4>{tool.name}</h4>
        </div>
        <span className={`rm-kind ${tool.writeCapable ? 'w' : 'r'}`}>
          {tool.kind === 'middleware_endpoint' ? 'existing endpoint' : 'ops runbook'}
          {tool.writeCapable ? '' : ' · read-only'}
        </span>
      </div>
      <p className="rm-desc">{tool.description}</p>
      {recommended && detectionReason !== undefined && (
        <p className="rm-when">Detected: {detectionReason}</p>
      )}
      <p className="rm-when">Applies when: {mapping.appliesWhen}</p>
      <pre className="rm-call">{callShape(tool)}</pre>
      {error !== null && <div className="rm-err">{error}</div>}
      {confirming ? (
        <ConfirmPanel
          tool={tool}
          subject={subject}
          busy={busy}
          onConfirm={() => void onConfirmRun()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="rm-actions">
          <button className="rm-btn" onClick={() => setConfirming(true)} disabled={busy}>
            {`Trigger: ${tool.name}`}
          </button>
        </div>
      )}
    </div>
  );
}

export function RemediationModal({
  subject,
  registry,
  onClose,
}: {
  subject: RemediationSubject | null;
  registry: RemediationRegistry | null;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<RemediationTriggerResult | null>(null);

  // Resolve the mapped tools for this subject, recommended first. The recommended
  // tool is the failure-mode-DETECTED one (issue #35) when the opener supplied it,
  // otherwise the static primary mapping (previous behaviour).
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

  // Reset the shown result whenever the subject changes.
  useEffect(() => {
    setResult(null);
  }, [subject]);

  // Focus the close button on open (focus lands inside the dialog).
  useEffect(() => {
    if (subject !== null) closeRef.current?.focus();
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

  return (
    <div className="rm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="rm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-title"
        ref={dialogRef}
      >
        <div className="rm-mh">
          <h3 id="rm-title">Remediation · {subject.label}</h3>
          <button className="rm-x" ref={closeRef} onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="rm-mb">
          {/* Unit 4: the "why" block is ALWAYS first, built from the subject's verdict
              + detail, so clicking any red/amber item explains itself even when no
              remediation tool is mapped. */}
          {subject.why !== undefined && (
            <div className={`rm-why v-${verdictWord(subject.verdict)}`}>
              <div className="rm-why-hd">Why this is {verdictWord(subject.verdict)}</div>
              <p className="rm-why-text">{subject.why}</p>
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
          )}
          {result !== null ? (
            <div className="rm-result" role="status">
              <div className={`rm-result-badge s-${result.status}`}>
                {result.status === 'triggered'
                  ? 'triggered'
                  : result.status === 'error'
                    ? 'trigger failed'
                    : 'would trigger'}
              </div>
              <p className="rm-result-msg">{result.message}</p>
              {result.status === 'error' && result.error !== undefined && (
                <div className="rm-err">{result.error}</div>
              )}
              <div className="rm-result-row">
                <span className="rm-k">Tool</span>
                <span className="rm-v">{result.toolName}</span>
              </div>
              <div className="rm-result-row">
                <span className="rm-k">Would call</span>
                <span className="rm-v mono">{result.wouldCall}</span>
              </div>
              <div className="rm-result-row">
                <span className="rm-k">Resolution recorded</span>
                <span className="rm-v">
                  {result.resolvedSubject
                    ? `${result.resolvedSubject.subjectKind}:${result.resolvedSubject.subjectKey}`
                    : 'no open transition to resolve'}
                </span>
              </div>
              <div className="rm-actions">
                <button className="rm-btn ghost" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          ) : cards.length === 0 ? (
            <div className="rm-nostep">
              <p className="rm-desc">No automated remediation tool is mapped for this item.</p>
              <p className="rm-when">
                Next step: {subject.nextStep ?? 'investigate the item above and hand it to the owning team; nothing here can be triggered.'}
              </p>
            </div>
          ) : (
            cards.map(({ mapping, tool, recommended }) => (
              <ToolCard
                key={tool.id}
                mapping={mapping}
                tool={tool}
                subject={subject}
                recommended={recommended}
                detectionReason={
                  recommended && tool.id === subject.detectedToolId ? subject.detectionReason : undefined
                }
                onResult={setResult}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
