// Shared formatting helpers for the Order Health UI. ASCII only: no em dashes
// anywhere in produced copy (a doubled hyphen "--" is the neutral placeholder).
import type { Verdict } from '@order-health/shared';

// Neutral placeholder for a value the API does not carry yet (middleware-sourced
// signals are stubbed until DevOps provisions them). Never a fabricated number.
export const PENDING = '--';

// Map a verdict to its single-letter theme class (matches styles.css: g/a/r/u).
export function verdictClass(v: Verdict): 'g' | 'a' | 'r' | 'u' {
  if (v === 'green') return 'g';
  if (v === 'amber') return 'a';
  if (v === 'red') return 'r';
  return 'u';
}

// Compact human age from seconds. null renders the neutral placeholder, never a
// zero or a guess. Format matches the demo: "41m", "1h 40m", "6h 12m".
export function humanAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return PENDING;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

// Age in seconds of an ISO timestamp relative to now. null-safe.
export function ageSecondsOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

// "22m ago" style label for an ISO timestamp; placeholder when absent.
export function agoLabel(iso: string | null | undefined): string {
  const s = ageSecondsOf(iso);
  if (s === null) return 'pending source';
  return `${humanAge(s)} ago`;
}

// Render a number that may be null: the value, or the neutral placeholder.
export function numOr(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return PENDING;
  return n.toLocaleString();
}

// Percent from a 0..1 ratio; placeholder when null.
export function pctOr(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return PENDING;
  return `${Math.round(ratio * 100)}%`;
}

// A short clock label ("15:30") from an ISO time; placeholder when absent.
export function clockOf(iso: string | null | undefined): string {
  if (!iso) return PENDING;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return PENDING;
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
