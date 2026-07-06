// health_transition repository (Unit 7).
//
// This is the I/O glue around the PURE diff in aggregator/transitions.ts. It reads
// the currently-open rows, applies the append / resolve actions the diff produced,
// and (for the notifier stub) tails the unresolved rows. It writes ONLY this
// service's own health_transition table; it never touches the middleware or NAV.
// DB-optional: when no DATABASE_URL is configured (scaffold / CI) every method is
// a logged no-op so the aggregator and the operator path both run without a DB.
import type { HealthTransition, Verdict } from '@order-health/shared';
import { hasDatabase } from '../config';
import { getPool, query } from '../db/pool';
import type {
  OpenTransition,
  SubjectKind,
  TransitionAction,
} from '../aggregator/transitions';

// The currently-open (resolved_at IS NULL) transitions, one per subject.
export async function getOpenTransitions(): Promise<OpenTransition[]> {
  if (!hasDatabase() || getPool() === null) return [];
  const rows = await query<{ subject_kind: SubjectKind; subject_key: string }>(
    `SELECT subject_kind, subject_key
       FROM health_transition
      WHERE resolved_at IS NULL`,
  );
  return rows.map((r) => ({ subjectKind: r.subject_kind, subjectKey: r.subject_key }));
}

// The latest snapshot's verdicts per subject, used as the "previous" side of the
// diff. Read from THIS service's own snapshot tables (no live source call).
export async function getPreviousVerdicts(): Promise<
  { subjectKind: SubjectKind; subjectKey: string; verdict: Verdict }[]
> {
  if (!hasDatabase() || getPool() === null) return [];
  const pipes = await query<{ pipe: string; pipe_verdict: Verdict }>(
    `SELECT pipe, pipe_verdict
       FROM pipeline_health_snapshot
      WHERE as_of = (SELECT max(as_of) FROM pipeline_health_snapshot)`,
  );
  const orders = await query<{ subject_key: string; order_verdict: Verdict }>(
    `SELECT COALESCE(nav_order_no, shopify_order_name, shopify_order_id, customer_ref) AS subject_key,
            order_verdict
       FROM order_health_snapshot
      WHERE as_of = (SELECT max(as_of) FROM order_health_snapshot)`,
  );
  return [
    ...pipes.map((p) => ({ subjectKind: 'pipe' as const, subjectKey: p.pipe, verdict: p.pipe_verdict })),
    ...orders
      .filter((o) => o.subject_key !== null)
      .map((o) => ({ subjectKind: 'order' as const, subjectKey: o.subject_key, verdict: o.order_verdict })),
  ];
}

// Apply the diff actions. Appends open rows and resolves open rows. No-op without
// a DB (the actions are still computed by the pure diff and can be logged).
export async function applyTransitionActions(actions: readonly TransitionAction[]): Promise<void> {
  if (actions.length === 0) return;
  if (!hasDatabase() || getPool() === null) {
    // eslint-disable-next-line no-console
    console.info(`[transitions] ${actions.length} transition action(s) computed; no DB, not persisted`);
    return;
  }
  for (const a of actions) {
    if (a.op === 'open') {
      await query(
        `INSERT INTO health_transition
           (subject_kind, subject_key, from_verdict, to_verdict, opened_at, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [a.subjectKind, a.subjectKey, a.from_verdict, a.to_verdict, a.opened_at, a.note],
      );
    } else {
      await query(
        `UPDATE health_transition
            SET resolved_at = $3, note = $4
          WHERE subject_kind = $1 AND subject_key = $2 AND resolved_at IS NULL`,
        [a.subjectKind, a.subjectKey, a.resolved_at, a.note],
      );
    }
  }
}

// Resolve an open transition as a REMEDIATION event (design.md 5A.4): the operator
// trigger records a resolution so the notifier can close an alert as well as open
// one. Returns whether a row was resolved. No-op / false without a DB.
export async function resolveForRemediation(
  subjectKind: SubjectKind,
  subjectKey: string,
  note: string,
  nowIso: string,
): Promise<boolean> {
  if (!hasDatabase() || getPool() === null) return false;
  const rows = await query<{ id: string }>(
    `UPDATE health_transition
        SET resolved_at = $3, note = $4
      WHERE subject_kind = $1 AND subject_key = $2 AND resolved_at IS NULL
      RETURNING id`,
    [subjectKind, subjectKey, nowIso, note],
  );
  return rows.length > 0;
}

// Tail the unresolved rows for the notifier stub. Read-only.
export async function tailUnresolvedTransitions(): Promise<HealthTransition[]> {
  if (!hasDatabase() || getPool() === null) return [];
  return query<HealthTransition>(
    `SELECT subject_kind, subject_key, from_verdict, to_verdict,
            opened_at, resolved_at, note
       FROM health_transition
      WHERE resolved_at IS NULL
      ORDER BY opened_at ASC`,
  );
}
