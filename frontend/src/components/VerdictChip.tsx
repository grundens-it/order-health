import type { Verdict } from '@order-health/shared';

// Verdict encoded by SHAPE as well as color (design.md: never color alone).
// green -> circle, amber -> rounded square, red -> rotated diamond, unknown -> slate.
const LABEL: Record<Verdict, string> = {
  green: 'Healthy',
  amber: 'At risk',
  red: 'Unhealthy',
  unknown: 'Unknown',
};

const CLASS: Record<Verdict, string> = {
  green: 'g',
  amber: 'a',
  red: 'r',
  unknown: '',
};

export function VerdictChip({ verdict }: { verdict: Verdict }): JSX.Element {
  const label = LABEL[verdict];
  return (
    <span className={`chip ${CLASS[verdict]}`} role="status" aria-label={label} title={label}>
      <span className="ic" aria-hidden="true" />
      {label}
    </span>
  );
}
