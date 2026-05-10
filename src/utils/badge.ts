/** Web App Badging API — desktop/mobile Chromium; fails silently when unsupported. */

export function setBadge(count: number): void {
  if (!("setAppBadge" in navigator)) return;
  try {
    void navigator.setAppBadge(count);
  } catch {
    // ignore
  }
}

export function clearBadge(): void {
  if (!("clearAppBadge" in navigator)) return;
  try {
    void navigator.clearAppBadge();
  } catch {
    // ignore
  }
}

export function updateBadge(bills: number, tasks: number, overBudget: number): void {
  const total = Math.max(0, Math.round(bills) + Math.round(tasks) + Math.round(overBudget));
  if (total === 0) {
    clearBadge();
    return;
  }
  setBadge(total);
}
