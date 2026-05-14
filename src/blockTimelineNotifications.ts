import { format, parseISO, startOfDay, subDays } from "date-fns";

/** Heads-up window before a scheduled block (minutes). */
export const BLOCK_HEADS_UP_LEAD_MIN = 5;
/** After a block ends, treat it as “just finished” for this many minutes so slow ticks still catch it. */
export const BLOCK_END_GRACE_MIN = 24;

const LS_ENABLED = "zero_block_timeline_notif_v1";
const LS_PENDING = "zero_block_finish_pending_v1";
const LS_FIRED = "zero_block_notif_fired_v1";

export type BlockNotifEvent = {
  id: number;
  title?: string;
  hour: number;
  startMinute?: number;
  durationMinutes?: number;
  date?: string;
};

export type PendingBlockFinish = {
  eventId: number;
  dateKey: string;
  title: string;
  category: string;
  endedAtIso: string;
};

export function blockTimelineNotifEnabledFromStorage(): boolean {
  try {
    return localStorage.getItem(LS_ENABLED) !== "0";
  } catch {
    return true;
  }
}

export function setBlockTimelineNotifEnabled(on: boolean): void {
  try {
    localStorage.setItem(LS_ENABLED, on ? "1" : "0");
  } catch {
    // ignore
  }
}

export function loadPendingBlockFinish(): PendingBlockFinish | null {
  try {
    const raw = localStorage.getItem(LS_PENDING);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<PendingBlockFinish>;
    if (typeof j.eventId !== "number" || typeof j.dateKey !== "string" || typeof j.title !== "string" || typeof j.endedAtIso !== "string") {
      return null;
    }
    return {
      eventId: j.eventId,
      dateKey: j.dateKey,
      title: j.title,
      category: typeof j.category === "string" ? j.category : "",
      endedAtIso: j.endedAtIso,
    };
  } catch {
    return null;
  }
}

export function savePendingBlockFinish(p: PendingBlockFinish): void {
  try {
    localStorage.setItem(LS_PENDING, JSON.stringify(p));
  } catch {
    // ignore
  }
}

export function clearPendingBlockFinish(): void {
  try {
    localStorage.removeItem(LS_PENDING);
  } catch {
    // ignore
  }
}

export function loadFiredKeys(today: Date): Set<string> {
  const cutoff = subDays(startOfDay(today), 3);
  try {
    const raw = localStorage.getItem(LS_FIRED);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return new Set();
    const filtered = arr.filter((k) => {
      if (typeof k !== "string") return false;
      const d = k.split("|")[0] ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      return parseISO(d) >= cutoff;
    });
    return new Set(filtered as string[]);
  } catch {
    return new Set();
  }
}

export function persistFiredKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(LS_FIRED, JSON.stringify([...keys].slice(-140)));
  } catch {
    // ignore
  }
}

export function formatBlockStartClock(ev: Pick<BlockNotifEvent, "hour" | "startMinute">): string {
  const d = new Date();
  const m = ev.hour * 60 + (ev.startMinute ?? 0);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return format(d, "h:mm a");
}

export function blockStartMinutes(ev: Pick<BlockNotifEvent, "hour" | "startMinute">): number {
  return ev.hour * 60 + (ev.startMinute ?? 0);
}

export function blockDurationMinutes(ev: Pick<BlockNotifEvent, "durationMinutes">): number {
  return Math.max(15, ev.durationMinutes ?? 60);
}
