import type { LifecycleStage } from '@order-health/shared';
import { STAGE_LABEL } from './OrderTable';

// Stage-filter value: a concrete lifecycle stage or 'all' (no stage filter).
// 'all' is a real value, mirroring ChannelFilter's 'all', never a sentinel.
export type StageFilterValue = LifecycleStage | 'all';

// Canonical stage order (matches shared LifecycleStage); drives the option list
// so the dropdown reads in lifecycle sequence.
const STAGES: LifecycleStage[] = [
  'shopify_order',
  'allocator_split',
  'nav_staging',
  'nav_promotion',
  'awaiting_ship',
  'nav_shipment',
  'back_sync',
  'complete',
];

// Lifecycle-stage filter. Mirrors ChannelFilter's contract (typed value +
// onChange, an explicit 'all' option, its own accessible label) but renders a
// native <select> rather than a segmented button row: with eight stages plus
// "all stages" a seg would overflow the control bar, and a labelled select is
// keyboard-usable out of the box. Option labels reuse OrderTable's STAGE_LABEL.
export function StageFilter({
  value,
  onChange,
}: {
  value: StageFilterValue;
  onChange: (next: StageFilterValue) => void;
}): JSX.Element {
  return (
    <label className="selctl">
      <span className="selctl-label">Stage</span>
      <select
        aria-label="Lifecycle stage filter"
        value={value}
        onChange={(e) => onChange(e.target.value as StageFilterValue)}
      >
        <option value="all">All stages</option>
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABEL[s]}
          </option>
        ))}
      </select>
    </label>
  );
}
