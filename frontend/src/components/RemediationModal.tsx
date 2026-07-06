import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  RemediationMapping,
  RemediationRegistry,
  RemediationTool,
  RemediationTriggerResult,
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

function ToolCard({
  mapping,
  tool,
  subject,
  onResult,
}: {
  mapping: RemediationMapping;
  tool: RemediationTool;
  subject: RemediationSubject;
  onResult: (r: RemediationTriggerResult) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onTrigger(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await triggerRemediation(tool.id, {
        subjectKind: subject.subjectKind,
        subjectKey: subject.subjectKey,
      });
      onResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'trigger failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rm-tool">
      <div className="rm-tool-hd">
        <div>
          <div className="rm-kicker">{mapping.primary ? 'Recommended tool' : 'Alternative'}</div>
          <h4>{tool.name}</h4>
        </div>
        <span className={`rm-kind ${tool.writeCapable ? 'w' : 'r'}`}>
          {tool.kind === 'middleware_endpoint' ? 'existing endpoint' : 'ops runbook'}
          {tool.writeCapable ? '' : ' · read-only'}
        </span>
      </div>
      <p className="rm-desc">{tool.description}</p>
      <p className="rm-when">Applies when: {mapping.appliesWhen}</p>
      <pre className="rm-call">{callShape(tool)}</pre>
      {error !== null && <div className="rm-err">{error}</div>}
      <div className="rm-actions">
        <button className="rm-btn" onClick={() => void onTrigger()} disabled={busy}>
          {busy ? 'Triggering...' : `Trigger: ${tool.name}`}
        </button>
      </div>
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

  // Resolve the mapped tools for this subject (primary first).
  const cards = useMemo(() => {
    if (subject === null || registry === null) return [];
    return registry.mappings
      .filter((m) => m.subjectKey === subject.subjectKey)
      .sort((a, b) => Number(b.primary) - Number(a.primary))
      .map((m) => ({ mapping: m, tool: toolFor(registry, m.toolId) }))
      .filter((x): x is { mapping: RemediationMapping; tool: RemediationTool } => x.tool !== null);
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
          {result !== null ? (
            <div className="rm-result" role="status">
              <div className="rm-result-badge">would trigger</div>
              <p className="rm-result-msg">{result.message}</p>
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
            <p className="rm-desc">No remediation is mapped for this signal.</p>
          ) : (
            cards.map(({ mapping, tool }) => (
              <ToolCard
                key={tool.id}
                mapping={mapping}
                tool={tool}
                subject={subject}
                onResult={setResult}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
