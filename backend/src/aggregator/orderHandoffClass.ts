// Order handoff classification: the reshaped health model.
//
// The old model graded "unhealthy" on ELAPSED TIME (past a ship SLO), which swept in
// normal warehouse lag, normal in-flight orders and preseason, and produced numbers
// that were not real (a "387 unhealthy" that meant nothing). This module replaces that
// with a DEFECT-based model: age alone never makes anything red, and every order is
// attributed to the party that actually owns the next action.
//
// Established from live NAV measurement (2026-07-21) and confirmed with the business:
//
//   * PRESEASON is a different animal. 2019 of 3300 open DTC orders were preseason;
//     their NAV planned ship date is a season target, not a fulfillment promise. They
//     are EXCLUDED from active order health entirely and get their own card.
//   * Holman Logistics (HF1FTZ) is 100% EDI via Lanham. A 940 that is sent AND
//     997-acknowledged is PROOF the order is in Holman's court. TRUST THE EDI: Holman
//     being behind is their throughput/SLA problem, never a pipeline defect, and the
//     tool must not tell an operator to "chase the 3PL".
//   * An unreleased order usually carries a NAV hold whose reason code names the
//     owning team (Finance/AR or Customer Service). Those are work queues, not defects.
//   * EL- orders are INTENTIONALLY skipped by autorelease pending a CU 5790 (Order
//     Promising) fix. That is a known code defect, tracked separately, not per-order ops.
//
// Pure: no I/O, no clock beyond the injected nowMs. Every branch is unit-testable.

// Who owns the next action on this order.
export type HandoffOwner =
  | 'holman'      // handed off and acknowledged; their SLA
  | 'finance'     // Finance / AR hold
  | 'customer_service'
  | 'engineering' // a known code defect (CU 5790 / EL- autorelease skip)
  | 'grundens_ops' // OUR pipeline defect: the handoff itself failed
  | 'none';       // nothing to do (in flight, or not yet due)

export type HandoffState =
  | 'preseason'          // excluded from active health, own card
  | 'with_holman'        // 940 sent + acked
  | 'awaiting_ack'       // 940 sent, 997 not back yet
  | 'handoff_failed'     // released but no 940, or 940 created and never sent
  | 'held_finance'
  | 'held_customer_service'
  | 'blocked_code_defect' // EL- / CU 5790 autorelease skip
  | 'backorder'          // no stock, a real supply wait
  | 'in_flight';         // recently created, nothing wrong yet

// A verdict the health rollup can consume. Only 'red' means WE have a defect.
export type HandoffVerdict = 'red' | 'amber' | 'green' | 'excluded';

export interface HandoffFacts {
  isPreseason: boolean;
  released: boolean;            // NAV Sales Header Status = Released
  ediSent: boolean;             // a Holman 940 exists with Document Sent = 1
  ediAcked: boolean;            // ...and Funct. Group Ack = 1 (the 997 came back)
  ediDocExists: boolean;        // a 940 row exists at all
  activeHoldReason: string | null; // Sales Document Hold Entry reason code, unreleased
  autoReleaseSkipped: boolean;  // Split Ship Trace EL.NoHoldNoRelease seen
  hasStock: boolean;            // any line available at HF1FTZ / TAC
  ageDays: number;              // age of the order
}

export interface HandoffResult {
  state: HandoffState;
  owner: HandoffOwner;
  verdict: HandoffVerdict;
  reason: string;
}

// Finance / AR vs Customer Service, from the NAV hold reason code. Unknown codes fall
// back to customer service so the order is still routed to a human, never dropped.
export function holdOwnerFor(code: string): HandoffOwner {
  const c = code.trim().toUpperCase();
  if (c === 'ACCTHOLD' || c === 'ACCTPREPAY' || c === 'ACCTCONT') return 'finance';
  return 'customer_service';
}

// How long a sent-but-unacked 940 may sit before we call it our problem. The 997 comes
// back quickly in practice, so this is generous rather than tight.
export const ACK_GRACE_DAYS = 2;

// How long a released order may sit with no 940 before it is a handoff defect. Cutting
// the 940 is near-immediate on release, so anything past this is a real failure.
export const HANDOFF_GRACE_DAYS = 1;

export function classifyHandoff(f: HandoffFacts): HandoffResult {
  // 1. Preseason is not active order health at all.
  if (f.isPreseason) {
    return {
      state: 'preseason',
      owner: 'none',
      verdict: 'excluded',
      reason: 'Preseason order: graded on stock coverage, not ship dates. Excluded from active order health.',
    };
  }

  // 2. TRUST THE EDI. Acked = in Holman's court = healthy, regardless of age and
  //    regardless of what the NAV header status says.
  if (f.ediSent && f.ediAcked) {
    return {
      state: 'with_holman',
      owner: 'holman',
      verdict: 'green',
      reason: 'EDI 940 sent and 997 acknowledged: the order is in Holman\'s court. Any delay from here is Holman throughput, not a pipeline defect.',
    };
  }

  // 3. Sent but not yet acknowledged: in flight, only our problem if it lingers.
  if (f.ediSent) {
    return f.ageDays > ACK_GRACE_DAYS
      ? {
          state: 'handoff_failed',
          owner: 'grundens_ops',
          verdict: 'red',
          reason: `EDI 940 was sent but no 997 acknowledgment after ${f.ageDays} days. The handoff is unconfirmed.`,
        }
      : {
          state: 'awaiting_ack',
          owner: 'none',
          verdict: 'green',
          reason: 'EDI 940 sent, awaiting the 997 acknowledgment. In flight.',
        };
  }

  // 4. A 940 was built but never transmitted: unambiguously ours.
  if (f.ediDocExists) {
    return {
      state: 'handoff_failed',
      owner: 'grundens_ops',
      verdict: 'red',
      reason: 'EDI 940 was created but never sent to Holman. The handoff failed on our side.',
    };
  }

  // 5. No 940 yet. A NAV hold explains it and names the owning team: a work queue,
  //    not a pipeline defect, so it must not be graded red.
  if (f.activeHoldReason !== null && f.activeHoldReason.trim().length > 0) {
    const owner = holdOwnerFor(f.activeHoldReason);
    return {
      state: owner === 'finance' ? 'held_finance' : 'held_customer_service',
      owner,
      verdict: 'amber',
      reason: `On hold in NAV (${f.activeHoldReason.trim()}); owned by ${owner === 'finance' ? 'Finance / AR' : 'Customer Service'}. Not a pipeline defect.`,
    };
  }

  // 6. The EL- autorelease skip: a known code defect (CU 5790 Order Promising), tracked
  //    centrally. Flagged so it is visible, but owned by engineering, not per-order ops.
  if (f.autoReleaseSkipped) {
    return {
      state: 'blocked_code_defect',
      owner: 'engineering',
      verdict: 'amber',
      reason: 'Autorelease intentionally skipped for EL- orders pending the CU 5790 (Order Promising) fix. Known defect, tracked centrally.',
    };
  }

  // 7. Genuinely no stock anywhere: a supply wait, not a defect.
  if (!f.hasStock) {
    return {
      state: 'backorder',
      owner: 'none',
      verdict: 'green',
      reason: 'No stock available at HF1FTZ or TAC: a real backorder awaiting supply, not a pipeline defect.',
    };
  }

  // 8. Released, stock on hand, no hold, no known defect, and still no 940 past the
  //    grace window: the handoff simply did not happen. This is OUR defect.
  if (f.released && f.ageDays > HANDOFF_GRACE_DAYS) {
    return {
      state: 'handoff_failed',
      owner: 'grundens_ops',
      verdict: 'red',
      reason: `Released ${f.ageDays} days ago with stock available, but no EDI 940 was ever created. The order never reached Holman.`,
    };
  }

  // 9. Anything else is simply new / not yet due.
  return {
    state: 'in_flight',
    owner: 'none',
    verdict: 'green',
    reason: 'Order is progressing normally; nothing is overdue.',
  };
}

// Roll a set of classified orders up to a pipe verdict. ONLY genuine defects (red)
// drive red. Preseason is excluded outright. Amber states are real work but owned by a
// named team, so they surface as amber, never as a pipeline failure.
export function rollupHandoff(results: HandoffResult[]): {
  verdict: HandoffVerdict;
  defects: number;
  ownedElsewhere: number;
  healthy: number;
  excluded: number;
} {
  let defects = 0;
  let ownedElsewhere = 0;
  let healthy = 0;
  let excluded = 0;
  for (const r of results) {
    if (r.verdict === 'excluded') excluded += 1;
    else if (r.verdict === 'red') defects += 1;
    else if (r.verdict === 'amber') ownedElsewhere += 1;
    else healthy += 1;
  }
  const verdict: HandoffVerdict = defects > 0 ? 'red' : ownedElsewhere > 0 ? 'amber' : 'green';
  return { verdict, defects, ownedElsewhere, healthy, excluded };
}
