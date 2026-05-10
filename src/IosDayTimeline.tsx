import { format } from "date-fns";
import { useMemo } from "react";

export type IosTimelineEvent = {
  id: number;
  title: string;
  hour: number;
  startMinute?: number;
  durationMinutes?: number;
  category: "work" | "health" | "personal";
  subtasks?: string[];
  date?: string;
};

function eventStartMinutes(e: IosTimelineEvent) {
  return e.hour * 60 + (e.startMinute ?? 0);
}

function eventDuration(e: IosTimelineEvent) {
  return Math.max(15, e.durationMinutes ?? 60);
}

function formatRange(startMin: number, durationMin: number) {
  const start = new Date();
  start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  return `${format(start, "h:mm a")} – ${format(end, "h:mm a")}`;
}

function categoryLabel(cat: IosTimelineEvent["category"]) {
  switch (cat) {
    case "work":
      return "Work";
    case "health":
      return "Health";
    default:
      return "Personal";
  }
}

function suggestNextSlot(events: IosTimelineEvent[], liveNow: Date): number {
  const snap = (m: number) => Math.round(Math.max(0, Math.min(24 * 60 - 15, m)) / 15) * 15;
  let m = snap(liveNow.getHours() * 60 + liveNow.getMinutes());
  m = Math.min(Math.max(m, 5 * 60), 24 * 60 - 30);
  const sorted = [...events].sort((a, b) => eventStartMinutes(a) - eventStartMinutes(b));
  const blocks = sorted.map((ev) => ({
    start: eventStartMinutes(ev),
    end: eventStartMinutes(ev) + eventDuration(ev),
  }));
  for (let step = 0; step < 64; step += 1) {
    const end = m + 60;
    const clash = blocks.some((b) => !(end <= b.start || m >= b.end));
    if (!clash) return m;
    m = snap(m + 15);
    if (m >= 24 * 60 - 30) break;
  }
  return snap(liveNow.getHours() * 60 + liveNow.getMinutes());
}

type Props = {
  events: IosTimelineEvent[];
  liveNow: Date;
  todayKey: string;
  onEditEvent: (e: IosTimelineEvent) => void;
  onAddAtMinuteOfDay: (dateKey: string, minuteOfDay: number) => void;
};

export function IosDayTimeline({ events, liveNow, todayKey, onEditEvent, onAddAtMinuteOfDay }: Props) {
  const nowMin = liveNow.getHours() * 60 + liveNow.getMinutes();

  const todayEvents = useMemo(
    () => events.filter((e) => (e.date ?? todayKey) === todayKey),
    [events, todayKey],
  );

  const sorted = useMemo(
    () => [...todayEvents].sort((a, b) => eventStartMinutes(a) - eventStartMinutes(b)),
    [todayEvents],
  );

  type Row = { kind: "now" } | { kind: "event"; ev: IosTimelineEvent };

  const rows = useMemo(() => {
    const out: Row[] = [];
    let insertedNow = false;

    for (let i = 0; i < sorted.length; i += 1) {
      const ev = sorted[i];
      const start = eventStartMinutes(ev);
      const prevEnd =
        i > 0 ? eventStartMinutes(sorted[i - 1]) + eventDuration(sorted[i - 1]) : -1;

      if (!insertedNow && nowMin >= prevEnd && nowMin < start) {
        out.push({ kind: "now" });
        insertedNow = true;
      }
      out.push({ kind: "event", ev });
    }

    if (!insertedNow) {
      if (sorted.length === 0) {
        out.push({ kind: "now" });
      } else {
        const last = sorted[sorted.length - 1];
        const lastEnd = eventStartMinutes(last) + eventDuration(last);
        if (nowMin >= lastEnd) out.push({ kind: "now" });
      }
    }

    return out;
  }, [sorted, nowMin]);

  const addSuggested = () => {
    const raw = suggestNextSlot(sorted, liveNow);
    const snapped = Math.round(Math.max(5 * 60, Math.min(24 * 60 - 15, raw)) / 15) * 15;
    onAddAtMinuteOfDay(todayKey, snapped);
  };

  return (
    <div className="ios-day-timeline">
      <header className="ios-day-timeline__header">
        <div>
          <h3 className="ios-day-timeline__title">Schedule</h3>
          <p className="muted ios-day-timeline__sub">{format(liveNow, "EEEE, MMM d")}</p>
        </div>
        <time className="ios-day-timeline__clock" dateTime={liveNow.toISOString()}>
          {format(liveNow, "h:mm a")}
        </time>
      </header>

      <div className="timeline-ios-list ios-day-timeline__list">
        {sorted.length === 0 && (
          <button type="button" className="timeline-ios-row" onClick={addSuggested}>
            <span className="timeline-ios-time">&nbsp;</span>
            <div className="timeline-ios-lane">
              <div className="timeline-ios-line" />
            </div>
            <div className="timeline-ios-content">
              <div className="timeline-ios-empty">Nothing scheduled today. Tap to add your first block.</div>
            </div>
          </button>
        )}

        {sorted.length > 0 &&
          rows.map((row, idx) => {
            if (row.kind === "now") {
              return (
                <div key={`now-${idx}`} className="timeline-ios-row current" aria-live="polite">
                  <span className="timeline-ios-time">{format(liveNow, "h:mm")}</span>
                  <div className="timeline-ios-lane">
                    <div className="timeline-ios-line" />
                    <span className="timeline-ios-now-dot" />
                  </div>
                  <div className="timeline-ios-content">
                    <span className="timeline-ios-now-pill">Now</span>
                  </div>
                </div>
              );
            }

            const ev = row.ev;
            const start = eventStartMinutes(ev);
            const dur = eventDuration(ev);
            const active = nowMin >= start && nowMin < start + dur;
            const timeCol = format(
              (() => {
                const d = new Date();
                d.setHours(Math.floor(start / 60), start % 60, 0, 0);
                return d;
              })(),
              "h:mm",
            );

            return (
              <button
                key={ev.id}
                type="button"
                className={`timeline-ios-row${active ? " current" : ""}`}
                onClick={() => onEditEvent({ ...ev, date: ev.date ?? todayKey })}
              >
                <span className="timeline-ios-time">{timeCol}</span>
                <div className="timeline-ios-lane">
                  <div className="timeline-ios-line" />
                  {active ? <span className="timeline-ios-now-dot" /> : null}
                </div>
                <div className="timeline-ios-content">
                  <div className={`timeline-ios-event ${ev.category}`}>
                    <div>
                      <strong>{ev.title?.trim() || "Untitled"}</strong>
                      <p>
                        {formatRange(start, dur)} · {categoryLabel(ev.category)}
                        {ev.subtasks && ev.subtasks.length > 0 ? ` · ${ev.subtasks.length} steps` : ""}
                      </p>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
      </div>

      {sorted.length > 0 && (
        <button type="button" className="ios-day-timeline__add" onClick={addSuggested}>
          Add event
        </button>
      )}
    </div>
  );
}
