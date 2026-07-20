import { useEffect, useState } from 'react';
import type { RemediationArmState } from '@order-health/shared';
import { fetchArmState, putArmState, putKillSwitch } from '../api';

// Admin-only arm/disarm + kill-switch panel (issue #97). Rendered by App ONLY when
// the resolved principal carries the Admin role; a non-Admin never sees it, and the
// server is still the real gate on every write (a non-Admin PUT is 403). The panel
// shows the effective posture (armed / disarmed, kill on / off), each flag's source
// (a runtime override vs the env default), and who last changed it. Toggling calls
// the endpoints and re-renders from the returned state, so the UI never guesses.

function stateWord(armed: boolean): string {
  return armed ? 'ARMED' : 'DISARMED';
}

export function AdminPanel(): JSX.Element {
  const [state, setState] = useState<RemediationArmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchArmState()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'failed to load arm state');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<RemediationArmState>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setState(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update failed');
    } finally {
      setBusy(false);
    }
  }

  const armed = state?.armed ?? false;
  const liveEnabled = state?.remediationLiveEnabled ?? false;
  const killed = state?.killSwitch ?? false;

  return (
    <div className="sec">
      <h2>Admin: remediation arm state</h2>
      <div className="rule" />
      <span className="aux">admin-only; disarmed by default; the aggregator never triggers remediation</span>

      <div className={`admin-panel${armed ? ' on' : ''}`}>
        {error !== null && <div className="rm-err">{error}</div>}
        {state === null && error === null ? (
          <p className="rm-desc">Loading arm state...</p>
        ) : (
          <>
            <div className="admin-state">
              <span className={`admin-badge ${armed ? 'armed' : 'disarmed'}`}>{stateWord(armed)}</span>
              <span className="aux">
                live enabled: <b>{String(liveEnabled)}</b> ({state?.liveEnabledSource ?? 'env_default'})
                {' · '}kill switch: <b>{String(killed)}</b> ({state?.killSwitchSource ?? 'env_default'})
              </span>
            </div>

            <div className="admin-row">
              <span className="admin-k">Executable remediation</span>
              <div className="admin-ctl">
                <button
                  className="rm-btn"
                  disabled={busy || liveEnabled}
                  onClick={() => void run(() => putArmState(true))}
                >
                  Arm
                </button>
                <button
                  className="rm-btn ghost"
                  disabled={busy || !liveEnabled}
                  onClick={() => void run(() => putArmState(false))}
                >
                  Disarm
                </button>
              </div>
            </div>

            <div className="admin-row">
              <span className="admin-k">Kill switch (forces disarmed)</span>
              <div className="admin-ctl">
                <button
                  className="rm-btn"
                  disabled={busy || killed}
                  onClick={() => void run(() => putKillSwitch(true))}
                >
                  Kill on
                </button>
                <button
                  className="rm-btn ghost"
                  disabled={busy || !killed}
                  onClick={() => void run(() => putKillSwitch(false))}
                >
                  Kill off
                </button>
              </div>
            </div>

            {state?.updatedBy !== null && state?.updatedBy !== undefined && (
              <p className="aux">
                last changed by <b>{state.updatedBy}</b>
                {state.updatedAt ? ` at ${new Date(state.updatedAt).toLocaleString()}` : ''}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
