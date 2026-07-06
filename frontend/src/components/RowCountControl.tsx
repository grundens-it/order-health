// Row-count value: a concrete cap or 'all' (no limit). Kept as a first-class
// union so the "All" option is a real value, never a magic sentinel number.
export type RowCount = 25 | 50 | 100 | 'all';

const OPTIONS: { value: RowCount; label: string }[] = [
  { value: 25, label: '25' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
  { value: 'all', label: 'All' },
];

// 25 / 50 / 100 / All segmented control. Caps how many order rows render after
// filtering + searching. Mirrors ChannelFilter's segmented-button structure and
// a11y (a labelled button group, keyboard usable) rather than a native select,
// because the four choices fit inline like the channel filter beside it.
export function RowCountControl({
  value,
  onChange,
}: {
  value: RowCount;
  onChange: (next: RowCount) => void;
}): JSX.Element {
  return (
    <div className="seg" role="group" aria-label="Rows shown">
      {OPTIONS.map((o) => (
        <button
          key={String(o.value)}
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
