import type { ChannelFilter as ChannelFilterValue } from '@order-health/shared';

const OPTIONS: { value: ChannelFilterValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'dtc', label: 'DTC' },
  { value: 'wholesale', label: 'Wholesale' },
];

// DTC / wholesale / all segmented control. Channel is first-class end to end, so
// wholesale is a real filter value, never a mis-graded orphan.
export function ChannelFilter({
  value,
  onChange,
}: {
  value: ChannelFilterValue;
  onChange: (next: ChannelFilterValue) => void;
}): JSX.Element {
  return (
    <div className="seg" role="group" aria-label="Channel filter">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'on' : ''}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
