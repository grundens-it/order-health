// Notifier STUB (Unit 7, design.md section 8: "Alerting hooks (designed, not built)").
//
// SCOPE BOUNDARY: this builds ONLY the tail of health_transition for unresolved
// rows plus a clearly-marked NO-OP sink. It does NOT deliver anything: no email,
// no Slack, no webhook, no paging. The single v1 hook is "the snapshot writer
// records a transition; a future notifier tails the table". Delivery is a later
// round (Unit 8 / DevOps seat) that swaps the no-op sink for a real dispatcher.
import type { HealthTransition } from '@order-health/shared';
import { tailUnresolvedTransitions } from '../repo/transitionRepo';

// The NO-OP sink. Unit 8 replaces this body with real delivery. It intentionally
// does nothing but log, so the tail can be exercised end to end without wiring a
// channel. NEVER add delivery here in this unit.
export function noopNotifySink(rows: readonly HealthTransition[]): void {
  // eslint-disable-next-line no-console
  console.info(
    `[notifier:stub] ${rows.length} unresolved transition(s) would notify here; ` +
      'no-op sink (delivery is a later round, design.md 8). No email/Slack/webhook sent.',
  );
}

// Tail the unresolved transitions and hand them to the sink. Read-only; makes no
// live source call and dispatches nothing. Returns the tailed rows for inspection.
export async function runNotifierTail(
  sink: (rows: readonly HealthTransition[]) => void = noopNotifySink,
): Promise<HealthTransition[]> {
  const rows = await tailUnresolvedTransitions();
  sink(rows);
  return rows;
}
