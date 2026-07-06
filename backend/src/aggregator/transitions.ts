// health_transition diff (Unit 7, design.md section 8 / ADR-0002).
//
// The snapshot writer is the single evaluation point: every time it recomputes a
// verdict it already knows whether a subject transitioned. This module is the
// PURE diff of "previous snapshot verdicts vs new snapshot verdicts, given the
// currently-open transition rows" -> the append / resolve actions to apply. It is
// a pure function (no I/O, no clock beyond the injected nowIso), so every rule is
// unit-testable without a DB (mirrors the inventorySync.ts pure-compute style).
//
// Rules (design.md 8): a subject going GREEN -> AMBER/RED OPENS a transition row;
// a return to GREEN RESOLVES the open row. 'unknown' is "not evaluated" and never
// opens or resolves. While a subject is already open (amber or red) no duplicate
// row is opened, even when it worsens amber -> red.
import type { Verdict } from '@order-health/shared';

export type SubjectKind = 'pipe' | 'signal' | 'order';

// One subject's verdict in a snapshot (previous or current).
export interface VerdictSubject {
  subjectKind: SubjectKind;
  subjectKey: string;
  verdict: Verdict;
}

// A currently-unresolved health_transition row (resolved_at IS NULL).
export interface OpenTransition {
  subjectKind: SubjectKind;
  subjectKey: string;
}

// The actions the writer applies to health_transition. 'open' appends a row;
// 'resolve' stamps resolved_at on the open row for that subject.
export type TransitionAction =
  | {
      op: 'open';
      subjectKind: SubjectKind;
      subjectKey: string;
      from_verdict: Verdict;
      to_verdict: Verdict;
      opened_at: string;
      note: string;
    }
  | {
      op: 'resolve';
      subjectKind: SubjectKind;
      subjectKey: string;
      resolved_at: string;
      note: string;
    };

// A verdict that warrants an open transition (something an operator should see).
// green is healthy; unknown is "not evaluated yet" and is deliberately NOT an
// open condition (it must not manufacture a transition before a source reports).
export function isUnhealthy(v: Verdict): boolean {
  return v === 'amber' || v === 'red';
}

function keyOf(s: { subjectKind: SubjectKind; subjectKey: string }): string {
  return `${s.subjectKind}:${s.subjectKey}`;
}

// Diff previous -> current given the open rows. Returns the ordered actions.
//   - newly unhealthy (amber/red) with no open row      -> open
//   - already open and still unhealthy                  -> no action (no duplicate)
//   - returned to green with an open row                -> resolve
//   - unknown, or unchanged-green                       -> no action
export function diffTransitions(
  previous: readonly VerdictSubject[],
  current: readonly VerdictSubject[],
  openTransitions: readonly OpenTransition[],
  nowIso: string,
): TransitionAction[] {
  const prevByKey = new Map(previous.map((s) => [keyOf(s), s.verdict]));
  const openByKey = new Set(openTransitions.map(keyOf));
  const actions: TransitionAction[] = [];

  for (const cur of current) {
    const k = keyOf(cur);
    const isOpen = openByKey.has(k);
    const prevVerdict = prevByKey.get(k) ?? 'unknown';

    if (isUnhealthy(cur.verdict)) {
      // Open only when there is no open row already (no duplicate while red/amber).
      if (!isOpen) {
        actions.push({
          op: 'open',
          subjectKind: cur.subjectKind,
          subjectKey: cur.subjectKey,
          from_verdict: prevVerdict,
          to_verdict: cur.verdict,
          opened_at: nowIso,
          note: `verdict ${prevVerdict} -> ${cur.verdict}`,
        });
      }
      // else: already open; worsening amber -> red does not open a second row.
      continue;
    }

    if (cur.verdict === 'green' && isOpen) {
      // Return to green resolves the open row.
      actions.push({
        op: 'resolve',
        subjectKind: cur.subjectKind,
        subjectKey: cur.subjectKey,
        resolved_at: nowIso,
        note: 'returned to green',
      });
    }
    // green-with-no-open or unknown: nothing to do.
  }

  return actions;
}
