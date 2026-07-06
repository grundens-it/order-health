// A small transient toast, ported from the demo. Purely a status surface (no live
// effect); used to confirm a refresh and to explain that a deep-link or the outage
// replay is not wired yet.
export function Toast({ message }: { message: string | null }): JSX.Element {
  return (
    <div className={`toast ${message ? 'on' : ''}`} role="status" aria-live="polite">
      {message && <span className="tk">ok</span>}
      {message}
    </div>
  );
}
