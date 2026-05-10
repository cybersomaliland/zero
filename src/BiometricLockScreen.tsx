import { useEffect, useRef, useState } from "react";
import { bioLockAuthenticate } from "./webauthnLock";

type Props = {
  onUnlocked: () => void;
  /** Clears lock keys only — use if Face ID fails after restore or device change. */
  onResetLock: () => void;
};

export function BiometricLockScreen({ onUnlocked, onResetLock }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const onUnlockedRef = useRef(onUnlocked);
  onUnlockedRef.current = onUnlocked;

  const unlock = async () => {
    setBusy(true);
    setError("");
    const ok = await bioLockAuthenticate();
    setBusy(false);
    if (ok) onUnlockedRef.current();
    else setError("Couldn’t verify — try again or use your device PIN if offered.");
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      setError("");
      const ok = await bioLockAuthenticate();
      if (cancelled) return;
      setBusy(false);
      if (ok) onUnlockedRef.current();
      else setError("Couldn’t verify — tap Unlock or use your device PIN if offered.");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="bio-lock-screen">
      <div className="bio-lock-card">
        <p className="bio-lock-kicker">Zero</p>
        <h2 className="bio-lock-title">Face ID lock</h2>
        <p className="muted bio-lock-sub">
          Face ID, Touch ID, or device PIN should appear automatically — use Unlock below if your browser waits for a tap.
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
