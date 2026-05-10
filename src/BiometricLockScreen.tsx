import { useState } from "react";
import { bioLockAuthenticate } from "./webauthnLock";

type Props = {
  onUnlocked: () => void;
  /** Clears lock keys only — use if Face ID fails after restore or device change. */
  onResetLock: () => void;
};

export function BiometricLockScreen({ onUnlocked, onResetLock }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const unlock = async () => {
    setBusy(true);
    setError("");
    const ok = await bioLockAuthenticate();
    setBusy(false);
    if (ok) onUnlocked();
    else setError("Couldn’t verify — try again or use your device PIN if offered.");
  };

  return (
    <div className="bio-lock-screen">
      <div className="bio-lock-card">
        <p className="bio-lock-kicker">Zero</p>
        <h2 className="bio-lock-title">Face ID lock</h2>
        <p className="muted bio-lock-sub">
          Unlock with Face ID, Touch ID, or your device PIN (whatever this phone or laptop normally uses).
        </p>
        <button type="button" className="bio-lock-unlock" disabled={busy} onClick={() => void unlock()}>
          {busy ? "Waiting…" : "Unlock"}
        </button>
        {error ? <p className="bio-lock-error">{error}</p> : null}
        <button type="button" className="bio-lock-reset" onClick={onResetLock}>
          Forgot / reset lock
        </button>
      </div>
    </div>
  );
}
