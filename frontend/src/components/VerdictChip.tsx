import type { Verdict } from '@order-health/shared';

// Verdict encoded by SHAPE as well as color (design.md: never color alone). Each
// of the four verdicts renders a DISTINCT shape, so the chip is legible with color
// removed: green -> filled circle, amber -> rounded square, red -> rotated diamond,
// unknown -> dash. The text label is always present as the third, redundant cue.
const LABEL: Record<Verdict, string> = {
  green: 'Healthy',
  amber: 'At risk',
  red: 'Unhealthy',
  unknown: 'Unknown',
};

// Every verdict has its own class so its shape is targetable in CSS; 'u' (unknown)
// is a real class (the dash), not an empty fall-through, so no two verdicts share
// a shape.
const CLASS: Record<Verdict, string> = {
  green: 'g',
  amber: 'a',
  red: 'r',
  unknown: 'u',
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
