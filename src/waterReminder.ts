export const WATER_REMINDER_STORAGE_KEY = "zero_water_reminder_v1";

export type WaterReminderState = {
  enabled: boolean;
  /** Minutes between reminders (clamped when used). */
  intervalMinutes: number;
  /** Inclusive start hour 0–23. */
  windowStartHour: number;
  /** Exclusive end hour 0–24, or overnight when end <= start. */
  windowEndHour: number;
  /** Last time a water notification was shown (epoch ms). */
  lastNotifiedAt: number | null;
  /** Do not notify until this time (epoch ms). */
  snoozeUntilMs: number | null;
};

export function defaultWaterReminderState(): WaterReminderState {
  return {
    enabled: true,
    intervalMinutes: 90,
    windowStartHour: 7,
    windowEndHour: 22,
    lastNotifiedAt: null,
    snoozeUntilMs: null,
  };
}

export function clampWaterIntervalMinutes(n: number): number {
  if (!Number.isFinite(n)) return 90;
  return Math.min(180, Math.max(30, Math.round(n)));
}

export const WATER_INTERVAL_PRESETS = [30, 45, 60, 90, 120] as const;

export function snapWaterIntervalToPreset(n: number): (typeof WATER_INTERVAL_PRESETS)[number] {
  const c = clampWaterIntervalMinutes(n);
  let best: (typeof WATER_INTERVAL_PRESETS)[number] = 90;
  let bestD = Infinity;
  for (const o of WATER_INTERVAL_PRESETS) {
    const d = Math.abs(o - c);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

export function clampHour(n: number, max = 23): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(0, Math.round(n)));
}

/** Exclusive end hour 1–24 (24 = through end of day). */
export function clampWindowEndHour(n: number): number {
  if (!Number.isFinite(n)) return 22;
  return Math.min(24, Math.max(1, Math.round(n)));
}

/** `end` exclusive when `end > start` (same calendar day). Overnight when `end <= start`. */
export function isWithinWaterWindow(now: Date, startHour: number, endHour: number): boolean {
  const h = now.getHours();
  const s = clampHour(startHour, 23);
  const e = clampWindowEndHour(endHour);
  if (e > s) return h >= s && h < e;
  return h >= s || h < e;
}

export function parseWaterReminderState(raw: string | null): WaterReminderState {
  const base = defaultWaterReminderState();
  if (!raw) return base;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
      intervalMinutes: snapWaterIntervalToPreset(Number(o.intervalMinutes)),
      windowStartHour: clampHour(Number(o.windowStartHour)),
      windowEndHour: clampWindowEndHour(Number(o.windowEndHour)),
      lastNotifiedAt:
        typeof o.lastNotifiedAt === "number" && Number.isFinite(o.lastNotifiedAt)
          ? Math.max(0, o.lastNotifiedAt)
          : null,
      snoozeUntilMs:
        typeof o.snoozeUntilMs === "number" && Number.isFinite(o.snoozeUntilMs)
          ? Math.max(0, o.snoozeUntilMs)
          : null,
    };
  } catch {
    return base;
  }
}

const WATER_LINES = [
  "A full glass now keeps headaches and fog away later.",
  "Small sip cadence beats one giant chug at midnight.",
  "Hydration is cheap insurance for focus and mood.",
  "Your brain is mostly water — refuel the tank.",
];

export function pickWaterNotificationBody(seedMs: number): string {
  const idx = Math.floor((seedMs / 60_000) % WATER_LINES.length);
  return WATER_LINES[idx] ?? WATER_LINES[0];
}
