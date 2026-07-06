// The "All / Needs attention" segmented control for the order table. Needs
// attention = amber OR red order verdict (in flight watching SLO, or stuck).
export type AttentionValue = 'all' | 'attn';

const OPTIONS: { value: AttentionValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attn', label: 'Needs attention' },
];

export function AttentionFilter({
  value,
  onChange,
}: {
  value: AttentionValue;
  onChange: (next: AttentionValue) => void;
}): JSX.Element {
  return (
    <div className="seg" role="group" aria-label="Attention filter">
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
