import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { addDays, format, isToday, isTomorrow, isYesterday, startOfDay } from "date-fns";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export type StructuredTimelineEvent = {
  id: number;
  title: string;
  hour: number;
  startMinute?: number;
  durationMinutes?: number;
  category: "work" | "health" | "personal";
  subtasks?: string[];
  /** Calendar day (yyyy-MM-dd). When omitted, parent treats event as belonging to “today” only. */
  date?: string;
};

const DAY_START_HOUR = 5;
const DAY_END_HOUR = 24;
const PX_PER_MIN = 2;
const SNAP_MIN = 15;

const DAY_HEADER_H = 38;
const DAY_PADDING_BOTTOM = 14;
const LOAD_CHUNK = 21;
const EDGE_SLOTS = 3.5;
const MIN_DAY_OFFSET = -800;
const MAX_DAY_OFFSET = 800;
const VIRTUAL_BUFFER = 4;

function eventStartMinutes(e: StructuredTimelineEvent) {
  return e.hour * 60 + (e.startMinute ?? 0);
}

function eventDuration(e: StructuredTimelineEvent) {
  return Math.max(15, e.durationMinutes ?? 60);
}

function categoryMeta(cat: StructuredTimelineEvent["category"]) {
  switch (cat) {
    case "work":
      return { icon: "◆", label: "Focus" };
    case "health":
      return { icon: "◇", label: "Health" };
    default:
      return { icon: "○", label: "Personal" };
  }
}

function detectOverlaps(events: StructuredTimelineEvent[]) {
  const sorted = [...events].sort((a, b) => eventStartMinutes(a) - eventStartMinutes(b));
  const conflictIds = new Set<number>();
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    const aEnd = eventStartMinutes(a) + eventDuration(a);
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j];
      const bStart = eventStartMinutes(b);
      if (bStart >= aEnd) break;
      conflictIds.add(a.id);
      conflictIds.add(b.id);
    }
  }
  return conflictIds;
}

function formatRange(startMin: number, durationMin: number) {
  const start = new Date();
  start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  return `${format(start, "h:mm a")} – ${format(end, "h:mm a")}`;
}

function formatDayHeading(d: Date) {
  if (isToday(d)) return "Today";
  if (isTomorrow(d)) return "Tomorrow";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEEE, MMM d");
}

type Props = {
  events: StructuredTimelineEvent[];
  liveNow: Date;
  /** Calendar “today” for legacy events without `date`. */
  todayKey: string;
  onEditEvent: (e: StructuredTimelineEvent) => void;
  onAddAtMinuteOfDay: (dateKey: string, minuteOfDay: number) => void;
  onReschedule: (id: number, dateKey: string, hour: number, startMinute: number) => void;
};

type DayStripProps = {
  dateKey: string;
  calendarDate: Date;
  /** Top offset of this day section inside the scroll inner container (px). */
  sectionTopPx: number;
  dayEvents: StructuredTimelineEvent[];
  todayKeyStr: string;
  expandedId: number | null;
  setExpandedId: React.Dispatch<React.SetStateAction<number | null>>;
  dragMovedRef: React.MutableRefObject<boolean>;
  trackHeightPx: number;
  dayStartMin: number;
  dayEndMin: number;
  nowMin: number;
  nowTopPx: number;
  onEditEvent: (e: StructuredTimelineEvent) => void;
  onRescheduleStrip: (id: number, hour: number, startMinute: number) => void;
};

const DayTimelineStrip = memo(function DayTimelineStrip({
  dateKey,
  calendarDate,
  sectionTopPx,
  dayEvents,
  todayKeyStr,
  expandedId,
  setExpandedId,
  dragMovedRef,
  trackHeightPx,
  dayStartMin,
  dayEndMin,
  nowMin,
  nowTopPx,
  onEditEvent,
  onRescheduleStrip,
}: DayStripProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const isCalendarToday = dateKey === todayKeyStr;
  const isPastDay = dateKey < todayKeyStr;
  const isFutureDay = dateKey > todayKeyStr;

  const conflictIds = useMemo(() => detectOverlaps(dayEvents), [dayEvents]);

  const sorted = useMemo(
    () => [...dayEvents].sort((a, b) => eventStartMinutes(a) - eventStartMinutes(b)),
    [dayEvents],
  );

  return (
    <div className="structured-day-section">
      <div className="structured-day-section__heading">
        <span className="structured-day-section__title">{formatDayHeading(calendarDate)}</span>
        <span className="structured-day-section__sub">{format(calendarDate, "MMM d, yyyy")}</span>
      </div>

      <div
        ref={trackRef}
        className="structured-timeline__track structured-timeline__track--in-day"
        style={{ minHeight: trackHeightPx }}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-structured-block]")) return;
          const scrollEl = trackRef.current?.closest(".structured-timeline__scroll") as HTMLDivElement | null;
          const tr = trackRef.current;
          if (!scrollEl || !tr) return;
          const scrollRect = scrollEl.getBoundingClientRect();
          const yContent = scrollEl.scrollTop + e.clientY - scrollRect.top;
          const localY = yContent - sectionTopPx - DAY_HEADER_H;
          const mins = dayStartMin + localY / PX_PER_MIN;
          const snapped = Math.round(Math.max(dayStartMin, Math.min(dayEndMin - SNAP_MIN, mins)) / SNAP_MIN) * SNAP_MIN;
          const addEv = new CustomEvent<{ dateKey: string; minuteOfDay: number }>("structured-add-request", {
            bubbles: true,
            detail: { dateKey, minuteOfDay: snapped },
          });
          tr.dispatchEvent(addEv as unknown as Event);
        }}
        role="presentation"
      >
        <div className="structured-timeline__glass" aria-hidden="true" />

        {isCalendarToday && (() => {
          const currentHr = Math.floor(nowMin / 60);
          if (currentHr < DAY_START_HOUR || currentHr >= DAY_END_HOUR) return null;
          const bandTop = (currentHr * 60 - dayStartMin) * PX_PER_MIN;
          return (
            <div
              className="structured-timeline__hour-highlight"
              aria-hidden="true"
              style={{ top: bandTop, height: 60 * PX_PER_MIN }}
            />
          );
        })()}

        {Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i).map((h) => {
          const topPx = (h * 60 - dayStartMin) * PX_PER_MIN;
          const label = h > 12 ? `${h - 12} PM` : h === 12 ? "12 PM" : `${h} AM`;
          return (
            <div key={h} className="structured-timeline__hour-row" style={{ top: topPx }}>
              <span className="structured-timeline__hour-label">{label}</span>
              <div className="structured-timeline__hour-line" />
            </div>
          );
        })}

        {isCalendarToday && (
          <motion.div
            className="structured-timeline__now-line"
            style={{ top: nowTopPx }}
            layout
            transition={{ type: "spring", stiffness: 380, damping: 35 }}
          >
            <span className="structured-timeline__now-glow" />
            <span className="structured-timeline__now-bar" />
          </motion.div>
        )}

        <AnimatePresence initial={false}>
          {sorted.map((ev) => {
            const start = eventStartMinutes(ev);
            const dur = eventDuration(ev);
            const topPx = (start - dayStartMin) * PX_PER_MIN;
            const heightPx = Math.max(dur * PX_PER_MIN, 52);
            const meta = categoryMeta(ev.category);
            const isActive = isCalendarToday && nowMin >= start && nowMin < start + dur;
            const ended = isPastDay || (isCalendarToday && nowMin >= start + dur);
            const progress = isFutureDay
              ? 0
              : isActive
                ? Math.min(100, Math.max(0, ((nowMin - start) / dur) * 100))
                : ended
                  ? 100
                  : 0;
            const expanded = expandedId === ev.id;
            const conflict = conflictIds.has(ev.id);
            const focus = dur >= 75;

            return (
              <motion.div
                key={`${dateKey}-${ev.id}`}
                data-structured-block
                layout
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className={clsx(
                  "structured-block",
                  `structured-block--${ev.category}`,
                  focus && "structured-block--focus",
                  isActive && "structured-block--active",
                  conflict && "structured-block--conflict",
                )}
                style={{ top: topPx, height: heightPx }}
                drag="y"
                dragMomentum={false}
                dragElastic={0.06}
                dragConstraints={trackRef}
                whileHover={{ scale: 1.008, boxShadow: "0 18px 44px rgba(15, 35, 68, 0.14)" }}
                whileTap={{ scale: 0.997 }}
                onDragStart={() => {
                  dragMovedRef.current = false;
                }}
                onDrag={(_, info) => {
                  if (Math.abs(info.offset.y) > 6) dragMovedRef.current = true;
                }}
                onDragEnd={(_, info) => {
                  const deltaMin = Math.round(info.offset.y / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
                  let nextStart = start + deltaMin;
                  nextStart = Math.max(dayStartMin, Math.min(dayEndMin - dur, nextStart));
                  const snapped = Math.round(nextStart / SNAP_MIN) * SNAP_MIN;
                  const nh = Math.floor(snapped / 60);
                  const nm = snapped % 60;
                  if (snapped !== start) onRescheduleStrip(ev.id, nh, nm);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (dragMovedRef.current) {
                    dragMovedRef.current = false;
                    return;
                  }
                  onEditEvent({ ...ev, date: dateKey });
                }}
              >
                <button
                  type="button"
                  className="structured-block__expand"
                  aria-expanded={expanded}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedId((id) => (id === ev.id ? null : ev.id));
                  }}
                >
                  {expanded ? "−" : "+"}
                </button>
                <div className="structured-block__top">
                  <span className="structured-block__icon" aria-hidden="true">{meta.icon}</span>
                  <div className="structured-block__titles">
                    <span className="structured-block__category">{meta.label}</span>
                    <strong className="structured-block__name">{ev.title || "Untitled block"}</strong>
                    <span className="structured-block__range">{formatRange(start, dur)}</span>
                  </div>
                </div>
                <div className="structured-block__meta-row">
                  <span className="structured-block__duration">{dur} min</span>
                  {conflict && <span className="structured-block__warn">Overlap</span>}
                  {focus && <span className="structured-block__focus-tag">Focus</span>}
                </div>
                <div className="structured-block__progress-track" aria-hidden="true">
                  <motion.div
                    className="structured-block__progress-fill"
                    initial={false}
                    animate={{ width: `${progress}%` }}
                    transition={{ type: "spring", stiffness: 300, damping: 28 }}
                  />
                </div>
                <AnimatePresence initial={false}>
                  {expanded && ev.subtasks && ev.subtasks.length > 0 && (
                    <motion.ul
                      className="structured-block__subtasks"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22 }}
                    >
                      {ev.subtasks.map((st) => (
                        <li key={st}>{st}</li>
                      ))}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
});

export function StructuredDayTimeline({
  events,
  liveNow,
  todayKey,
  onEditEvent,
  onAddAtMinuteOfDay,
  onReschedule,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragMovedRef = useRef(false);
  const prependAdjustRef = useRef<number | null>(null);
  const didInitialScrollRef = useRef(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [localNow, setLocalNow] = useState(() => new Date());
  const [rangeMin, setRangeMin] = useState(-52);
  const [rangeMax, setRangeMax] = useState(52);
  const [vScrollTop, setVScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    setLocalNow(liveNow);
  }, [liveNow]);

  useEffect(() => {
    const id = window.setInterval(() => setLocalNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const dayStartMin = DAY_START_HOUR * 60;
  const dayEndMin = DAY_END_HOUR * 60;
  const totalMin = dayEndMin - dayStartMin;
  const trackHeightPx = totalMin * PX_PER_MIN;
  const daySectionHeight = DAY_HEADER_H + trackHeightPx + DAY_PADDING_BOTTOM;

  const nowMin = localNow.getHours() * 60 + localNow.getMinutes() + localNow.getSeconds() / 60;
  const nowTopPx = Math.min(Math.max(0, nowMin - dayStartMin), totalMin) * PX_PER_MIN;

  const startDay = useMemo(() => {
    const [y, m, d] = todayKey.split("-").map(Number);
    return startOfDay(new Date(y, m - 1, d));
  }, [todayKey]);

  const todayKeyStr = todayKey;

  const eventsByDate = useMemo(() => {
    const map = new Map<string, StructuredTimelineEvent[]>();
    for (const e of events) {
      const dk = e.date ?? todayKeyStr;
      const list = map.get(dk);
      if (list) list.push(e);
      else map.set(dk, [e]);
    }
    return map;
  }, [events, todayKeyStr]);

  const totalSlots = rangeMax - rangeMin + 1;
  const edgePx = EDGE_SLOTS * daySectionHeight;

  const offsetForIndex = useCallback((idx: number) => rangeMin + idx, [rangeMin]);

  const scrollHandler = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const st = el.scrollTop;
    setVScrollTop(st);

    if (st < edgePx && rangeMin > MIN_DAY_OFFSET) {
      const delta = Math.min(LOAD_CHUNK, rangeMin - MIN_DAY_OFFSET);
      if (delta <= 0) return;
      prependAdjustRef.current = st + delta * daySectionHeight;
      setRangeMin((r) => r - delta);
      return;
    }

    const distBottom = el.scrollHeight - st - el.clientHeight;
    if (distBottom < edgePx && rangeMax < MAX_DAY_OFFSET) {
      const delta = Math.min(LOAD_CHUNK, MAX_DAY_OFFSET - rangeMax);
      if (delta > 0) setRangeMax((r) => r + delta);
    }
  }, [edgePx, rangeMin, rangeMax, daySectionHeight]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const adj = prependAdjustRef.current;
    if (el != null && adj != null) {
      el.scrollTop = adj;
      prependAdjustRef.current = null;
      setVScrollTop(adj);
    }
  }, [rangeMin]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || didInitialScrollRef.current || viewportH < 80) return;
    const idxToday = -rangeMin;
    const target = Math.max(0, idxToday * daySectionHeight + nowTopPx - viewportH * 0.35);
    el.scrollTop = target;
    setVScrollTop(target);
    didInitialScrollRef.current = true;
  }, [viewportH, rangeMin, daySectionHeight, nowTopPx]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onAdd = (e: Event) => {
      const ce = e as CustomEvent<{ dateKey: string; minuteOfDay: number }>;
      const { dateKey, minuteOfDay } = ce.detail ?? {};
      if (!dateKey || minuteOfDay == null) return;
      onAddAtMinuteOfDay(dateKey, minuteOfDay);
    };
    root.addEventListener("structured-add-request", onAdd);
    return () => root.removeEventListener("structured-add-request", onAdd);
  }, [onAddAtMinuteOfDay]);

  const centerIdx = Math.floor((vScrollTop + viewportH / 2) / daySectionHeight);
  const clampedIdx = Math.max(0, Math.min(totalSlots - 1, centerIdx));
  const focusedOffset = offsetForIndex(clampedIdx);
  const focusedDate = addDays(startDay, focusedOffset);

  const firstVirt = Math.max(0, Math.floor(vScrollTop / daySectionHeight) - VIRTUAL_BUFFER);
  const lastVirt = Math.min(totalSlots - 1, Math.ceil((vScrollTop + Math.max(viewportH, 400)) / daySectionHeight) + VIRTUAL_BUFFER);

  const totalInnerHeight = totalSlots * daySectionHeight;

  return (
    <div className="structured-timeline">
      <div className="structured-timeline__header">
        <div>
          <h3 className="structured-timeline__title">{formatDayHeading(focusedDate)}</h3>
          <p className="structured-timeline__subtitle">{format(focusedDate, "EEEE, MMM d · yyyy")}</p>
        </div>
        <div className="structured-timeline__live-pill" aria-live="polite">
          <span className="structured-timeline__live-dot" />
          {format(localNow, "h:mm a")}
        </div>
      </div>

      <div className="structured-timeline__scroll" ref={scrollRef} onScroll={scrollHandler}>
        <div className="structured-timeline__days-inner" style={{ height: totalInnerHeight, position: "relative" }}>
          {Array.from({ length: lastVirt - firstVirt + 1 }, (_, k) => firstVirt + k).map((idx) => {
            const offset = offsetForIndex(idx);
            const dateKey = format(addDays(startDay, offset), "yyyy-MM-dd");
            const calendarDate = addDays(startDay, offset);
            const top = idx * daySectionHeight;
            const dayEvents = eventsByDate.get(dateKey) ?? [];

            return (
              <div
                key={dateKey}
                className="structured-day-section-wrap"
                style={{ position: "absolute", top, left: 0, right: 0, minHeight: daySectionHeight }}
              >
                <DayTimelineStrip
                  dateKey={dateKey}
                  calendarDate={calendarDate}
                  sectionTopPx={top}
                  dayEvents={dayEvents}
                  todayKeyStr={todayKeyStr}
                  expandedId={expandedId}
                  setExpandedId={setExpandedId}
                  dragMovedRef={dragMovedRef}
                  trackHeightPx={trackHeightPx}
                  dayStartMin={dayStartMin}
                  dayEndMin={dayEndMin}
                  nowMin={nowMin}
                  nowTopPx={nowTopPx}
                  onEditEvent={onEditEvent}
                  onRescheduleStrip={(id, hour, startMinute) => onReschedule(id, dateKey, hour, startMinute)}
                />
              </div>
            );
          })}
        </div>

        <p className="structured-timeline__hint">
          Scroll for other days · Tap empty space to add · Drag to reschedule · 15 min snap
        </p>
      </div>
    </div>
  );
}
