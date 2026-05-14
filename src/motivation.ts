import {
  eachDayOfInterval,
  endOfWeek,
  format,
  parseISO,
  startOfDay,
  startOfWeek,
  subDays,
} from "date-fns";

/** Aligns with `logic.ts` weekly budget window (Saturday start). */
const WEEK_STARTS_ON = 6 as const;

export type MotivationMeta = {
  maxStreakSeen: number;
};

export type MotSnap = {
  timelineEvents?: Array<{ hour?: number; startMinute?: number; category?: string; date?: string }>;
  tasks?: Array<{ done?: boolean }>;
  meals?: Array<{ planned?: boolean; done?: boolean }>;
  dayRating?: number | null;
};

export type MotTemplateBlock = { hour: number; category: string };

const ROUTINE_TEMPLATE_MATCH_SLACK_MIN = 90;

function timelineStartMinutes(e: { hour?: number; startMinute?: number }) {
  return (e.hour ?? 0) * 60 + (e.startMinute ?? 0);
}

function routineDayTimelineEvents(dayKey: string, snap: MotSnap) {
  return (snap.timelineEvents ?? []).filter((e) => (e.date ?? dayKey) === dayKey);
}

function routineTemplateSlotScore(dayKey: string, snap: MotSnap, template: MotTemplateBlock[]): number | null {
  if (template.length === 0) return null;
  const dayEvents = routineDayTimelineEvents(dayKey, snap);
  let matched = 0;
  for (const block of template) {
    const targetMin = block.hour * 60;
    const hasSlot = dayEvents.some((ev) => {
      if (ev.category !== block.category) return false;
      return Math.abs(timelineStartMinutes(ev) - targetMin) <= ROUTINE_TEMPLATE_MATCH_SLACK_MIN;
    });
    if (hasSlot) matched += 1;
  }
  return Math.round((100 * matched) / template.length);
}

function routineTaskAdherenceScore(snap: MotSnap): number | null {
  const list = snap.tasks ?? [];
  if (list.length === 0) return null;
  const done = list.filter((t) => t.done).length;
  return Math.round((100 * done) / list.length);
}

function routinePlannedMealScore(snap: MotSnap): number | null {
  const list = snap.meals ?? [];
  const planned = list.filter((m) => m.planned);
  if (planned.length === 0) return null;
  const done = planned.filter((m) => m.done).length;
  return Math.round((100 * done) / planned.length);
}

function routineDayCombinedAdherence(dayKey: string, snap: MotSnap, template: MotTemplateBlock[]): number | null {
  const parts = [
    routineTemplateSlotScore(dayKey, snap, template),
    routineTaskAdherenceScore(snap),
    routinePlannedMealScore(snap),
  ].filter((n): n is number => n != null);
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

function snapshotSignalsDay(snap: MotSnap) {
  return (
    (snap.timelineEvents?.length ?? 0) > 0 ||
    (snap.tasks?.length ?? 0) > 0 ||
    (snap.meals?.length ?? 0) > 0 ||
    snap.dayRating != null
  );
}

function averageAdherenceLastNDays(
  routineHistory: Record<string, MotSnap>,
  template: MotTemplateBlock[],
  liveNow: Date,
  windowDays: number,
): { average: number | null; daysWithData: number } {
  const acc: number[] = [];
  for (let i = 0; i < windowDays; i += 1) {
    const d = format(subDays(startOfDay(liveNow), i), "yyyy-MM-dd");
    const snap = routineHistory[d];
    if (!snap) continue;
    const s = routineDayCombinedAdherence(d, snap, template);
    if (s != null) acc.push(s);
  }
  if (acc.length === 0) return { average: null, daysWithData: 0 };
  return {
    average: Math.round(acc.reduce((a, b) => a + b, 0) / acc.length),
    daysWithData: acc.length,
  };
}

export type MotivationBadge = {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
};

export type RoutineMilestone = {
  id: string;
  title: string;
  detail: string;
  done: boolean;
};

export type XpBreakdownRow = { label: string; amount: number };

export type MotivationView = {
  totalXp: number;
  xpBreakdown: XpBreakdownRow[];
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  badges: MotivationBadge[];
  weeklyWins: string[];
  routineMilestones: RoutineMilestone[];
};

function levelProgress(totalXp: number): Pick<MotivationView, "level" | "xpIntoLevel" | "xpForNextLevel"> {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  let need = 120;
  while (remaining >= need) {
    remaining -= need;
    level += 1;
    need = Math.min(480, Math.round(120 + (level - 1) * 28));
  }
  return { level, xpIntoLevel: remaining, xpForNextLevel: need };
}

export function defaultMotivationMeta(): MotivationMeta {
  return { maxStreakSeen: 0 };
}

export function parseMotivationMeta(raw: string | null): MotivationMeta {
  if (!raw) return defaultMotivationMeta();
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const maxStreakSeen = typeof o.maxStreakSeen === "number" && Number.isFinite(o.maxStreakSeen)
      ? Math.max(0, Math.floor(o.maxStreakSeen))
      : 0;
    return { maxStreakSeen };
  } catch {
    return defaultMotivationMeta();
  }
}

export type BuildMotivationInput = {
  now: Date;
  transactions: Array<{ date: string }>;
  routineHistory: Record<string, MotSnap>;
  routineTemplate: MotTemplateBlock[];
  streakDays: number;
  meta: MotivationMeta;
  /** yyyy-MM-dd for “today” in the app’s calendar. */
  liveTodayKey: string;
  /** Live routine payload for that day (timeline, checklist, meals, rating). */
  liveTodaySnap: MotSnap;
};

export function buildMotivationView(input: BuildMotivationInput): MotivationView {
  const {
    now,
    transactions,
    routineHistory,
    routineTemplate,
    streakDays,
    meta,
    liveTodayKey,
    liveTodaySnap,
  } = input;

  const mergedHistory: Record<string, MotSnap> = {
    ...routineHistory,
    [liveTodayKey]: liveTodaySnap,
  };

  const uniqueRoutineKeys = Object.keys(routineHistory).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
  const routineDayKeys = new Set(uniqueRoutineKeys);
  routineDayKeys.add(liveTodayKey);
  let routineDaysLogged = 0;
  for (const k of routineDayKeys) {
    const snap = k === liveTodayKey ? liveTodaySnap : routineHistory[k];
    if (snap && snapshotSignalsDay(snap)) routineDaysLogged += 1;
  }

  const weekStart = startOfWeek(startOfDay(now), { weekStartsOn: WEEK_STARTS_ON });
  const weekEnd = endOfWeek(startOfDay(now), { weekStartsOn: WEEK_STARTS_ON });
  const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd }).map((d) => format(d, "yyyy-MM-dd"));

  let txsThisWeek = 0;
  for (const tx of transactions) {
    const d = parseISO(tx.date);
    if (Number.isNaN(+d)) continue;
    const key = format(startOfDay(d), "yyyy-MM-dd");
    if (weekDays.includes(key)) txsThisWeek += 1;
  }

  let routineSignalDaysThisWeek = 0;
  let maxTimelineInWeek = 0;
  let plannedMealsDoneWeek = 0;
  let dayRating5InLast7 = false;

  for (const dayKey of weekDays) {
    const snap = dayKey === liveTodayKey ? liveTodaySnap : routineHistory[dayKey];
    if (!snap) continue;
    if (snapshotSignalsDay(snap)) routineSignalDaysThisWeek += 1;
    const evLen = snap.timelineEvents?.length ?? 0;
    maxTimelineInWeek = Math.max(maxTimelineInWeek, evLen);
    const meals = snap.meals ?? [];
    for (const m of meals) {
      if (m.planned && m.done) plannedMealsDoneWeek += 1;
    }
    const dr = snap.dayRating ?? null;
    if (dr === 5) dayRating5InLast7 = true;
  }

  for (let i = 0; i < 7; i += 1) {
    const d = format(subDays(startOfDay(now), i), "yyyy-MM-dd");
    const snap = d === liveTodayKey ? liveTodaySnap : routineHistory[d];
    if (!snap) continue;
    if ((snap.dayRating ?? null) === 5) dayRating5InLast7 = true;
  }

  const { average: last7Avg, daysWithData: last7Days } = averageAdherenceLastNDays(
    mergedHistory,
    routineTemplate,
    now,
    7,
  );

  const txPart = Math.min(transactions.length * 3, 120);
  const streakPart = Math.min(streakDays * 10, 220);
  const routineDaysPart = Math.min(routineDaysLogged * 8, 240);
  const adherencePart =
    last7Avg != null && last7Days >= 2 ? Math.min(Math.round(last7Avg * 1.15), 130) : 0;
  const weekTouchPart = Math.min(routineSignalDaysThisWeek * 10, 70);
  const checklistDoneToday = (liveTodaySnap.tasks ?? []).filter((t) => t.done).length;
  const checklistPart = Math.min(checklistDoneToday * 2, 36);
  const templatePart = Math.min(routineTemplate.length * 6, 48);
  const drToday = liveTodaySnap.dayRating ?? null;
  const ratingBonus = drToday != null && drToday >= 4 ? 12 + (drToday === 5 ? 8 : 0) : 0;

  const xpBreakdown: XpBreakdownRow[] = [
    { label: "Money log (lifetime)", amount: txPart },
    { label: "Activity streak", amount: streakPart },
    { label: "Routine days saved", amount: routineDaysPart },
    { label: "7-day adherence quality", amount: adherencePart },
    { label: "This week’s routine touches", amount: weekTouchPart },
    { label: "Today’s checklist", amount: checklistPart },
    { label: "Day template blocks", amount: templatePart },
    { label: "Today’s day rating", amount: ratingBonus },
  ].filter((r) => r.amount > 0);

  const totalXp = Math.min(99999, xpBreakdown.reduce((s, r) => s + r.amount, 0));
  const { level, xpIntoLevel, xpForNextLevel } = levelProgress(totalXp);

  const maxStreak = Math.max(streakDays, meta.maxStreakSeen);

  const badges: MotivationBadge[] = [
    {
      id: "first_touch",
      title: "First touch",
      description: "Log money or save a routine day.",
      unlocked: transactions.length >= 1 || routineDaysLogged >= 1,
    },
    {
      id: "habit_chain",
      title: "Week chain",
      description: "Hit a 7-day activity streak.",
      unlocked: maxStreak >= 7,
    },
    {
      id: "iron_chain",
      title: "Month chain",
      description: "Reach a 30-day activity streak (lifetime best counts).",
      unlocked: maxStreak >= 30,
    },
    {
      id: "map_maker",
      title: "Template builder",
      description: "Shape your day with at least 3 template blocks.",
      unlocked: routineTemplate.length >= 3,
    },
    {
      id: "steady_hand",
      title: "Steady rhythm",
      description: "Average 70%+ routine adherence over the last week (4+ scored days).",
      unlocked: last7Avg != null && last7Avg >= 70 && last7Days >= 4,
    },
    {
      id: "weekly_rhythm",
      title: "Weekly regular",
      description: "Touch your routine on 5+ days this calendar week.",
      unlocked: routineSignalDaysThisWeek >= 5,
    },
    {
      id: "money_mind",
      title: "Budget cadence",
      description: "Log 4+ transactions this week.",
      unlocked: txsThisWeek >= 4,
    },
    {
      id: "sunseeker",
      title: "Bright days",
      description: "Give at least one day a top energy rating in the last week.",
      unlocked: dayRating5InLast7,
    },
    {
      id: "nourish",
      title: "Planned fuel",
      description: "Complete 6+ planned meals this week.",
      unlocked: plannedMealsDoneWeek >= 6,
    },
    {
      id: "depths",
      title: "Deep blocks",
      description: "Schedule 5+ timeline blocks on a single day this week.",
      unlocked: maxTimelineInWeek >= 5,
    },
  ];

  const weeklyWins: string[] = [];
  if (txsThisWeek > 0) {
    weeklyWins.push(`Logged ${txsThisWeek} transaction${txsThisWeek === 1 ? "" : "s"} this week — your budget brain stays trained.`);
  } else {
    weeklyWins.push("No transactions yet this week — add one when you spend or earn to keep the forecast honest.");
  }
  weeklyWins.push(
    routineSignalDaysThisWeek > 0
      ? `Routine signal on ${routineSignalDaysThisWeek} day${routineSignalDaysThisWeek === 1 ? "" : "s"} this week (Sat–Fri window).`
      : "Routine signal: open the Routine tab once this week to start a streak-friendly rhythm.",
  );
  weeklyWins.push(
    streakDays > 0
      ? `Activity streak: ${streakDays} day${streakDays === 1 ? "" : "s"} in a row (money + routine signals).`
      : "Activity streak starts when you log money or touch your routine today.",
  );
  if (last7Avg != null && last7Days > 0) {
    weeklyWins.push(`Last 7-day routine adherence ~${last7Avg}% across ${last7Days} scored day${last7Days === 1 ? "" : "s"}.`);
  } else {
    weeklyWins.push("Adherence score will appear after a few days with checklist, meals, or timeline blocks.");
  }
  const checklistTotalToday = (liveTodaySnap.tasks ?? []).length;
  if (checklistTotalToday > 0) {
    weeklyWins.push(
      `Today’s checklist: ${checklistDoneToday}/${checklistTotalToday} done (${Math.round((100 * checklistDoneToday) / checklistTotalToday)}%).`,
    );
  }

  const peakEnergyDays = new Set<string>();
  for (const [k, snap] of Object.entries(routineHistory)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if ((snap?.dayRating ?? null) === 5) peakEnergyDays.add(k);
  }
  if ((liveTodaySnap.dayRating ?? null) === 5) peakEnergyDays.add(liveTodayKey);
  const energy5Count = peakEnergyDays.size;

  const routineMilestones: RoutineMilestone[] = [
    {
      id: "m_first_day",
      title: "First routine day",
      detail: "Save any routine signal (timeline, checklist, meals, or day rating).",
      done: routineDaysLogged >= 1,
    },
    {
      id: "m_template",
      title: "Template online",
      detail: "Add at least one block to your day template.",
      done: routineTemplate.length >= 1,
    },
    {
      id: "m_streak_7",
      title: "Seven-day streak",
      detail: "Stack seven consecutive days with money or routine activity.",
      done: maxStreak >= 7,
    },
    {
      id: "m_streak_30",
      title: "Thirty-day streak",
      detail: "Keep the chain going for a full month (best streak counts).",
      done: maxStreak >= 30,
    },
    {
      id: "m_adherence_week",
      title: "Focused week",
      detail: "Hold 70%+ average adherence over the last seven days (need 3+ scored days).",
      done: last7Avg != null && last7Avg >= 70 && last7Days >= 3,
    },
    {
      id: "m_energy_notes",
      title: "Peak energy days",
      detail: "Rate five different days at full energy (5/5).",
      done: energy5Count >= 5,
    },
  ];

  return {
    totalXp,
    xpBreakdown,
    level,
    xpIntoLevel,
    xpForNextLevel,
    badges,
    weeklyWins,
    routineMilestones,
  };
}

export function nextMotivationMeta(current: MotivationMeta, streakDays: number): MotivationMeta {
  return {
    maxStreakSeen: Math.max(current.maxStreakSeen, streakDays),
  };
}
