import { AnimatePresence, motion } from "framer-motion";
import { differenceInCalendarDays, eachDayOfInterval, endOfMonth, format, formatDistanceToNow, getDay, parseISO, startOfDay, startOfMonth } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { askGroqFinanceAssistant } from "./ai";
import { CATEGORY_NAMES, getCategoryDefinition } from "./categories";
import { db } from "./db";
import { askFinanceAssistant, computeBudgetSnapshot, forecast, getUpcomingBills, money } from "./logic";
import { fetchSomalilandNews, type NewsItem } from "./news";
import { useZeroStore } from "./store";
import type { Subscription, SubscriptionCycle, TxType } from "./types";

const tabs = ["Home", "Transactions", "Subscriptions", "Insights", "Settings"] as const;
type Tab = (typeof tabs)[number];
const tabMeta: Record<Tab, { icon: "home" | "activity" | "subscriptions" | "insights" | "settings"; label: string }> = {
  Home: { icon: "home", label: "Home" },
  Transactions: { icon: "activity", label: "Activity" },
  Subscriptions: { icon: "subscriptions", label: "Subs" },
  Insights: { icon: "insights", label: "Routine" },
  Settings: { icon: "settings", label: "Settings" },
};
const DEFAULT_CHAT: Array<{ role: "assistant" | "user"; text: string }> = [
  { role: "assistant", text: "I am Coach Zero. Ask me what to do today with your money." },
];
type TimelineCategory = "work" | "health" | "personal";
type TaskPriority = "high" | "medium" | "low";
type TimelineEvent = { id: number; title: string; hour: number; category: TimelineCategory; durationMinutes?: number };
type RoutineTemplateBlock = { id: number; name: string; hour: number; durationMinutes: number; category: TimelineCategory };
type PlanAheadItem = { id?: number; date: string; title: string; hour: number; category: TimelineCategory; createdAt: string };
type RoutineReminderItem = { id: number; label: string; delaySeconds: number; enabled: boolean };
type RoutineDaySnapshot = {
  timelineEvents: TimelineEvent[];
  tasks: Array<{ id: number; title: string; priority: TaskPriority; category: TimelineCategory; done: boolean }>;
  meals: Array<{ id: number; name: string; group?: MealGroup; planned?: boolean; done: boolean; calories: string }>;
  ritualEnergy: number;
  dayRating: 1 | 2 | 3 | 4 | 5 | null;
};
type MealGroup = "Breakfast" | "Lunch" | "Dinner" | "Snacks";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function App() {
  const { loading, transactions, subscriptions, settings, init, addTransaction, deleteTransaction, updateTransaction, addSubscription, updateSubscription, addTransactionsBulk, updateSettings, clearData, recategorizeTransactions } = useZeroStore();
  const [tab, setTab] = useState<Tab>("Home");
  const [showTx, setShowTx] = useState(false);
  const [showSub, setShowSub] = useState(false);
  const [showBulkTx, setShowBulkTx] = useState(false);
  const [showWeeklySafe, setShowWeeklySafe] = useState(false);
  const [showMonthlyBalance, setShowMonthlyBalance] = useState(false);
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState("");
  const [activeHeadlineIndex, setActiveHeadlineIndex] = useState(0);
  const [editingTx, setEditingTx] = useState<any | null>(null);
  const [editingSub, setEditingSub] = useState<Subscription | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQuestion, setAssistantQuestion] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantEngine, setAssistantEngine] = useState<"groq" | "fallback">("fallback");
  const [assistantEngineReason, setAssistantEngineReason] = useState("");
  const [showMorningBriefing, setShowMorningBriefing] = useState(false);
  const [morningQuestion, setMorningQuestion] = useState("");
  const [ritualReview, setRitualReview] = useState("");
  const [ritualPriorityOne, setRitualPriorityOne] = useState("");
  const [ritualPriorityTwo, setRitualPriorityTwo] = useState("");
  const [ritualPriorityThree, setRitualPriorityThree] = useState("");
  const [ritualIntention, setRitualIntention] = useState("");
  const [ritualAvoid, setRitualAvoid] = useState("");
  const [ritualEnergy, setRitualEnergy] = useState<number>(3);
  const [timelineSortAsc, setTimelineSortAsc] = useState(true);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const routineReminderBody = "Time to review your routine and next priority.";
  const [coachNudgesEnabled] = useState(true);
  const [showReminderSheet, setShowReminderSheet] = useState(false);
  const [meals, setMeals] = useState<Array<{ id: number; name: string; group?: MealGroup; planned?: boolean; done: boolean; calories: string }>>([]);
  const [tasks, setTasks] = useState<Array<{ id: number; title: string; priority: TaskPriority; category: TimelineCategory; done: boolean }>>([]);
  const [routineTemplate, setRoutineTemplate] = useState<RoutineTemplateBlock[]>([]);
  const [planAheadItems, setPlanAheadItems] = useState<PlanAheadItem[]>([]);
  const [routineReminders, setRoutineReminders] = useState<RoutineReminderItem[]>([]);
  const [showTimelineSheet, setShowTimelineSheet] = useState(false);
  const [editingTimelineEvent, setEditingTimelineEvent] = useState<TimelineEvent | null>(null);
  const [showTemplateSheet, setShowTemplateSheet] = useState(false);
  const [editingTemplateBlock, setEditingTemplateBlock] = useState<RoutineTemplateBlock | null>(null);
  const [showPlanAheadSheet, setShowPlanAheadSheet] = useState(false);
  const [editingPlanAheadItem, setEditingPlanAheadItem] = useState<PlanAheadItem | null>(null);
  const [showRoutineReminderSheet, setShowRoutineReminderSheet] = useState(false);
  const [editingRoutineReminder, setEditingRoutineReminder] = useState<RoutineReminderItem | null>(null);
  const [reflectionOne, setReflectionOne] = useState("");
  const [reflectionTwo, setReflectionTwo] = useState("");
  const [dayRating, setDayRating] = useState<1 | 2 | 3 | 4 | 5 | null>(null);
  const [dayClosed, setDayClosed] = useState(false);
  const [routineHydrated, setRoutineHydrated] = useState(false);
  const [, setRoutineHistory] = useState<Record<string, RoutineDaySnapshot>>({});
  const [currentHour, setCurrentHour] = useState(new Date().getHours());
  const [selectedCalendarDay, setSelectedCalendarDay] = useState<string>(format(new Date(), "yyyy-MM-dd"));
  const [showCalendarDaySheet, setShowCalendarDaySheet] = useState(false);
  const [chat, setChat] = useState<Array<{ role: "assistant" | "user"; text: string }>>(() => {
    try {
      const raw = localStorage.getItem("zero_ai_chat_v1");
      if (!raw) return DEFAULT_CHAT;
      const parsed = JSON.parse(raw) as Array<{ role: "assistant" | "user"; text: string }>;
      if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_CHAT;
      return parsed;
    } catch {
      return DEFAULT_CHAT;
    }
  });
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [notifState, setNotifState] = useState<"unsupported" | "default" | "granted" | "denied">(
    "default",
  );
  const [pushConnected, setPushConnected] = useState(false);
  const [pushStatusDetail, setPushStatusDetail] = useState("");
  const [testNotifDelaySec, setTestNotifDelaySec] = useState("10");
  const [scheduledNotifAt, setScheduledNotifAt] = useState<number | null>(null);
  const [timerNow, setTimerNow] = useState<number>(Date.now());
  const scheduledNotifTimeoutRef = useRef<number | null>(null);
  const routineNotificationCacheRef = useRef<Record<string, 1>>({});

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (newsItems.length <= 1) return;
    const id = window.setInterval(() => {
      setActiveHeadlineIndex((i) => (i + 1) % newsItems.length);
    }, 4500);
    return () => window.clearInterval(id);
  }, [newsItems]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("zero_routine_v1");
      if (!raw) {
        setRoutineHydrated(true);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<{
        ritualReview: string;
        ritualPriorityOne: string;
        ritualPriorityTwo: string;
        ritualPriorityThree: string;
        ritualIntention: string;
        ritualAvoid: string;
        ritualEnergy: number;
        timelineSortAsc: boolean;
        timelineEvents: TimelineEvent[];
        meals: Array<{ id: number; name: string; group?: MealGroup; planned?: boolean; done: boolean; calories: string }>;
        tasks: Array<{ id: number; title: string; priority: TaskPriority; category: TimelineCategory; done: boolean }>;
        reflectionOne: string;
        reflectionTwo: string;
        dayRating: 1 | 2 | 3 | 4 | 5 | null;
        dayClosed: boolean;
      }>;
      if (typeof parsed.ritualReview === "string") setRitualReview(parsed.ritualReview);
      if (typeof parsed.ritualPriorityOne === "string") setRitualPriorityOne(parsed.ritualPriorityOne);
      if (typeof parsed.ritualPriorityTwo === "string") setRitualPriorityTwo(parsed.ritualPriorityTwo);
      if (typeof parsed.ritualPriorityThree === "string") setRitualPriorityThree(parsed.ritualPriorityThree);
      if (typeof parsed.ritualIntention === "string") setRitualIntention(parsed.ritualIntention);
      if (typeof parsed.ritualAvoid === "string") setRitualAvoid(parsed.ritualAvoid);
      if (typeof parsed.ritualEnergy === "number") setRitualEnergy(parsed.ritualEnergy);
      if (typeof parsed.timelineSortAsc === "boolean") setTimelineSortAsc(parsed.timelineSortAsc);
      if (Array.isArray(parsed.timelineEvents)) setTimelineEvents(parsed.timelineEvents);
      if (Array.isArray(parsed.meals)) setMeals(parsed.meals);
      if (Array.isArray(parsed.tasks)) setTasks(parsed.tasks);
      if (typeof parsed.reflectionOne === "string") setReflectionOne(parsed.reflectionOne);
      if (typeof parsed.reflectionTwo === "string") setReflectionTwo(parsed.reflectionTwo);
      if (parsed.dayRating === null || [1, 2, 3, 4, 5].includes(parsed.dayRating as number)) setDayRating(parsed.dayRating ?? null);
      if (typeof parsed.dayClosed === "boolean") setDayClosed(parsed.dayClosed);
      try {
        const rawHistory = localStorage.getItem("zero_routine_history_v1");
        if (rawHistory) {
          const parsedHistory = JSON.parse(rawHistory) as Record<string, RoutineDaySnapshot>;
          if (parsedHistory && typeof parsedHistory === "object") {
            setRoutineHistory(parsedHistory);
          }
        }
      } catch {
        // ignore corrupt history cache
      }
    } catch {
      // ignore corrupt routine cache
    } finally {
      setRoutineHydrated(true);
    }
  }, []);
  useEffect(() => {
    if (!routineHydrated) return;
    const payload = {
      ritualReview,
      ritualPriorityOne,
      ritualPriorityTwo,
      ritualPriorityThree,
      ritualIntention,
      ritualAvoid,
      ritualEnergy,
      timelineSortAsc,
      timelineEvents,
      meals,
      tasks,
      reflectionOne,
      reflectionTwo,
      dayRating,
      dayClosed,
    };
    localStorage.setItem("zero_routine_v1", JSON.stringify(payload));
    const dayKey = format(new Date(), "yyyy-MM-dd");
    const snapshot: RoutineDaySnapshot = {
      timelineEvents,
      tasks,
      meals,
      ritualEnergy,
      dayRating,
    };
    setRoutineHistory((prev) => {
      const nextHistory = {
        ...prev,
        [dayKey]: snapshot,
      };
      localStorage.setItem("zero_routine_history_v1", JSON.stringify(nextHistory));
      return nextHistory;
    });
  }, [
    routineHydrated,
    ritualReview,
    ritualPriorityOne,
    ritualPriorityTwo,
    ritualPriorityThree,
    ritualIntention,
    ritualAvoid,
    ritualEnergy,
    timelineSortAsc,
    timelineEvents,
    meals,
    tasks,
    dayRating,
    ritualEnergy,
    reflectionOne,
    reflectionTwo,
    dayClosed,
  ]);
  useEffect(() => {
    try {
      const rawTemplate = localStorage.getItem("zero_routine_template_v1");
      if (rawTemplate) {
        const parsed = JSON.parse(rawTemplate) as RoutineTemplateBlock[];
        if (Array.isArray(parsed)) setRoutineTemplate(parsed);
      }
      const rawReminders = localStorage.getItem("zero_routine_reminders_v1");
      if (rawReminders) {
        const parsed = JSON.parse(rawReminders) as RoutineReminderItem[];
        if (Array.isArray(parsed)) setRoutineReminders(parsed);
      }
    } catch {
      // ignore corrupt cache
    }
  }, []);
  useEffect(() => {
    localStorage.setItem("zero_routine_template_v1", JSON.stringify(routineTemplate));
  }, [routineTemplate]);
  useEffect(() => {
    localStorage.setItem("zero_routine_reminders_v1", JSON.stringify(routineReminders));
  }, [routineReminders]);
  useEffect(() => {
    void db.table("routinePlans").toArray().then((rows) => {
      setPlanAheadItems(rows as PlanAheadItem[]);
    }).catch(() => {
      setPlanAheadItems([]);
    });
  }, []);
  useEffect(() => {
    if (!settings) return;
    const key = `zero_morning_briefing_seen_${format(new Date(), "yyyy-MM-dd")}`;
    const alreadySeen = localStorage.getItem(key);
    if (alreadySeen) return;
    const timer = window.setTimeout(() => {
      setShowMorningBriefing(true);
      localStorage.setItem(key, "1");
    }, 450);
    return () => window.clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    localStorage.setItem("zero_ai_chat_v1", JSON.stringify(chat));
  }, [chat]);

  useEffect(() => {
    if (!assistantOpen) return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [assistantOpen, chat, assistantBusy]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setCurrentHour(new Date().getHours());
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (notifState !== "granted") return;
    if (!("serviceWorker" in navigator)) return;
    if (timelineEvents.length === 0) return;

    const checkRoutineNotifications = async () => {
      const now = new Date();
      const nowMs = now.getTime();
      const dayKey = format(now, "yyyy-MM-dd");
      const registration = await navigator.serviceWorker.ready;

      for (const event of timelineEvents) {
        const startAt = new Date(now);
        startAt.setHours(event.hour, 0, 0, 0);
        const endAt = new Date(startAt.getTime() + Math.max(15, event.durationMinutes ?? 60) * 60_000);

        const startDelta = nowMs - startAt.getTime();
        const endDelta = nowMs - endAt.getTime();
        const startKey = `${dayKey}_${event.id}_start`;
        const endKey = `${dayKey}_${event.id}_end`;

        if (startDelta >= 0 && startDelta < 60_000 && !routineNotificationCacheRef.current[startKey]) {
          await registration.showNotification("Routine block started", {
            body: `${event.title} is starting now.`,
            icon: "/icon.svg",
            badge: "/icon.svg",
            tag: startKey,
            data: { url: "/" },
          });
          routineNotificationCacheRef.current[startKey] = 1;
        }

        if (endDelta >= 0 && endDelta < 60_000 && !routineNotificationCacheRef.current[endKey]) {
          await registration.showNotification("Routine block finished", {
            body: `${event.title} just ended. Time for your next move.`,
            icon: "/icon.svg",
            badge: "/icon.svg",
            tag: endKey,
            data: { url: "/" },
          });
          routineNotificationCacheRef.current[endKey] = 1;
        }
      }

      localStorage.setItem("zero_routine_notified_v1", JSON.stringify(routineNotificationCacheRef.current));
    };

    void checkRoutineNotifications();
    const id = window.setInterval(() => {
      void checkRoutineNotifications();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [notifState, timelineEvents]);

  const refreshNews = async () => {
    const controller = new AbortController();
    setNewsLoading(true);
    setNewsError("");
    try {
      const items = await fetchSomalilandNews(controller.signal);
      setNewsItems(items);
      if (items.length === 0) setNewsError("No Somaliland headlines found right now.");
    } catch {
      setNewsError("News temporarily unavailable.");
    } finally {
      setNewsLoading(false);
    }
  };

  const budgetSnapshot = useMemo(() => {
    if (!settings) {
      return {
        currentBalance: 0,
        monthlyRealBalance: 0,
        dailyAllowance: 0,
        weeklySafeToUse: 0,
        todaySpent: 0,
        todayRemaining: 0,
        weeklySpent: 0,
        weeklyIncome: 0,
        weeklyUpcomingSubs: 0,
        daysInMonth: 1,
        daysLeftInWeek: 1,
        daysLeftInMonth: 1,
        monthIncomeToDate: 0,
        monthExpenseToDate: 0,
        plannedIncomeRemaining: 0,
        remainingMonthSubscriptions: 0,
      };
    }
    return computeBudgetSnapshot(transactions, subscriptions, settings);
  }, [transactions, subscriptions, settings]);
  const realBalance = budgetSnapshot.currentBalance;
  const monthlySalary = settings?.monthlySalary ?? 0;
  const monthlyRealBalance = budgetSnapshot.monthlyRealBalance;
  const weeklySafeToUse = budgetSnapshot.weeklySafeToUse;
  const safePerDay = budgetSnapshot.dailyAllowance;
  const weeklySpent = budgetSnapshot.weeklySpent;
  const weeklyIncome = budgetSnapshot.weeklyIncome;
  const weeklyUpcomingSubs = budgetSnapshot.weeklyUpcomingSubs;
  const upcoming = useMemo(() => getUpcomingBills(subscriptions), [subscriptions]);
  const forecastData = useMemo(
    () => (settings ? forecast(transactions, subscriptions, settings) : []),
    [transactions, subscriptions, settings],
  );
  const spendingCalendar = useMemo(() => {
    const now = new Date();
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const spendByDay = transactions
      .filter((tx) => tx.type === "expense" && format(parseISO(tx.date), "yyyy-MM") === format(now, "yyyy-MM"))
      .reduce<Record<string, number>>((acc, tx) => {
        const key = format(parseISO(tx.date), "yyyy-MM-dd");
        acc[key] = (acc[key] || 0) + Math.abs(tx.amount);
        return acc;
      }, {});

    const blanks = Array.from({ length: getDay(monthStart) }, (_, i) => ({
      key: `blank-${i}`,
      blank: true as const,
    }));
    const cells = days.map((d) => {
      const key = format(d, "yyyy-MM-dd");
      return {
        key,
        blank: false as const,
        day: format(d, "d"),
        amount: spendByDay[key] || 0,
        today: key === format(now, "yyyy-MM-dd"),
      };
    });
    return [...blanks, ...cells];
  }, [transactions]);
  const dailyBreakdown = useMemo(() => {
    return transactions.reduce<Record<string, { spent: number; income: number; count: number }>>((acc, tx) => {
      const key = format(parseISO(tx.date), "yyyy-MM-dd");
      if (!acc[key]) acc[key] = { spent: 0, income: 0, count: 0 };
      acc[key].count += 1;
      if (tx.type === "expense") acc[key].spent += Math.abs(tx.amount);
      else acc[key].income += Math.abs(tx.amount);
      return acc;
    }, {});
  }, [transactions]);
  const selectedDayTransactions = useMemo(
    () =>
      transactions
        .filter((tx) => format(parseISO(tx.date), "yyyy-MM-dd") === selectedCalendarDay)
        .sort((a, b) => +parseISO(b.date) - +parseISO(a.date)),
    [transactions, selectedCalendarDay],
  );
  const selectedDayDailyAllowance = useMemo(() => {
    const selected = parseISO(selectedCalendarDay);
    const daysLeftFromSelectedDay = Math.max(
      1,
      differenceInCalendarDays(endOfMonth(selected), startOfDay(selected)) + 1,
    );
    return Math.max(0, monthlyRealBalance / daysLeftFromSelectedDay);
  }, [selectedCalendarDay, monthlyRealBalance]);
  const todaySpent = budgetSnapshot.todaySpent;
  const todayRemaining = budgetSnapshot.todayRemaining;
  const streakDays = useMemo(() => {
    const txDays = new Set(
      transactions.map((tx) => format(parseISO(tx.date), "yyyy-MM-dd")),
    );
    let streak = 0;
    const cursor = new Date();
    while (true) {
      const key = format(cursor, "yyyy-MM-dd");
      if (!txDays.has(key)) break;
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }, [transactions]);
  const sortedTimelineEvents = useMemo(() => {
    const copy = [...timelineEvents];
    copy.sort((a, b) => timelineSortAsc ? a.hour - b.hour : b.hour - a.hour);
    return copy;
  }, [timelineEvents, timelineSortAsc]);
  const currentTimelineBlock = useMemo(() => {
    const now = new Date();
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    const active = sortedTimelineEvents.find((event) => {
      const start = event.hour * 60;
      const duration = Math.max(15, event.durationMinutes ?? 60);
      return minuteOfDay >= start && minuteOfDay < start + duration;
    });
    if (!active) return null;
    const endMinute = active.hour * 60 + Math.max(15, active.durationMinutes ?? 60);
    return { ...active, minutesLeft: Math.max(0, endMinute - minuteOfDay) };
  }, [sortedTimelineEvents, currentHour]);
  const routineHours = useMemo(() => Array.from({ length: 18 }, (_, i) => i + 6), []);
  const taskPriorityWeight: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
  const todayChecklist = useMemo(
    () => [...tasks].sort((a, b) => taskPriorityWeight[a.priority] - taskPriorityWeight[b.priority]),
    [tasks],
  );
  const tomorrowLabel = format(new Date(Date.now() + 24 * 60 * 60 * 1000), "yyyy-MM-dd");
  const tomorrowPlans = useMemo(
    () => planAheadItems.filter((item) => item.date === tomorrowLabel).sort((a, b) => a.hour - b.hour),
    [planAheadItems, tomorrowLabel],
  );
  const laterWeekPlans = useMemo(
    () => planAheadItems.filter((item) => item.date > tomorrowLabel).sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour),
    [planAheadItems, tomorrowLabel],
  );
  const mealStats = useMemo(() => {
    const planned = meals.length;
    const completed = meals.filter((m) => m.done).length;
    const totalCalories = meals.reduce((acc, m) => acc + (Number(m.calories) || 0), 0);
    const completion = planned > 0 ? Math.round((completed / planned) * 100) : 0;
    return { planned, completed, totalCalories, completion };
  }, [meals]);
  const doneTasks = useMemo(() => tasks.filter((t) => t.done).length, [tasks]);
  const overallScore = useMemo(() => {
    const taskPct = tasks.length ? doneTasks / tasks.length : 0;
    const mealPct = mealStats.completion / 100;
    return Math.round(((taskPct + mealPct) / 2) * 100);
  }, [tasks, doneTasks, mealStats.completion]);
  const dailyBriefing = useMemo(() => {
    const openTasks = Math.max(0, tasks.length - doneTasks);
    const moneySignal = todayRemaining >= 0 ? "on track" : "over target";
    const mealSignal = mealStats.planned > 0 ? `${mealStats.completed}/${mealStats.planned} meals done` : "no meals planned yet";
    const taskSignal = tasks.length > 0 ? `${doneTasks}/${tasks.length} tasks done` : "no tasks planned yet";
    return {
      openTasks,
      moneySignal,
      mealSignal,
      taskSignal,
      nextBills: getUpcomingBills(subscriptions, 3).length,
    };
  }, [tasks, doneTasks, todayRemaining, mealStats, subscriptions]);
  const sortedNews = useMemo(
    () => [...newsItems].sort((a, b) => {
      const ta = a.publishedAt ? +new Date(a.publishedAt) : 0;
      const tb = b.publishedAt ? +new Date(b.publishedAt) : 0;
      return tb - ta;
    }),
    [newsItems],
  );
  const latestNews = sortedNews[0];
  const latestNewsIsFresh = useMemo(() => {
    if (!latestNews?.publishedAt) return false;
    const t = +new Date(latestNews.publishedAt);
    if (!Number.isFinite(t) || t <= 0) return false;
    const ageMs = Date.now() - t;
    return ageMs >= 0 && ageMs <= 24 * 60 * 60 * 1000;
  }, [latestNews]);
  const fallbackHeadline = newsItems[activeHeadlineIndex];
  const coachSuggestions = useMemo(() => {
    const items: string[] = [];
    if (todayRemaining < 0) items.push(`Slow spending this morning. You are ${money(Math.abs(todayRemaining))} over today's target.`);
    else items.push(`You are within budget with about ${money(todayRemaining)} left for today.`);
    if (tasks.length > 0 && doneTasks < tasks.length) items.push(`Complete 1 priority task now (${doneTasks}/${tasks.length} done).`);
    else if (tasks.length > 0) items.push("Great momentum: all planned tasks are completed.");
    if (mealStats.planned > 0 && mealStats.completed < mealStats.planned) items.push(`Meal plan is ${mealStats.completed}/${mealStats.planned}. Prep next meal early.`);
    if (dailyBriefing.nextBills > 0) items.push(`${dailyBriefing.nextBills} bill(s) due in the next 3 days. Keep a cash buffer.`);
    if (fallbackHeadline) items.push(`News watch: ${fallbackHeadline.title}`);
    return items.slice(0, 4);
  }, [todayRemaining, tasks.length, doneTasks, mealStats, dailyBriefing.nextBills, fallbackHeadline]);
  const smartSavingsTip = useMemo(() => {
    const safeToday = Math.max(0, todayRemaining);
    const dailySaveTarget = Math.max(1, safePerDay * 0.25);
    const projectedThreeDayBoost = dailySaveTarget * 3;
    const projectedSpendingRoom = safeToday + projectedThreeDayBoost;
    const foodBudgetAfterThreeDays = Math.max(2, projectedSpendingRoom * 0.35);

    if (safePerDay <= 0) {
      return "Set your balance and upcoming bills first, then I can generate a realistic daily saving plan.";
    }
    if (todayRemaining < 0) {
      return `Recovery mode: keep food to essentials today and save ${money(dailySaveTarget)} per day for 3 days to rebuild about ${money(projectedThreeDayBoost)}.`;
    }
    return `Save about ${money(dailySaveTarget)} per day for 3 days and you'll add around ${money(projectedThreeDayBoost)} buffer. Then a safe food budget is about ${money(foodBudgetAfterThreeDays)}.`;
  }, [todayRemaining, safePerDay]);
  const allowanceProgressPct = useMemo(() => {
    if (safePerDay <= 0) return 0;
    return Math.min(100, Math.max(0, (Math.max(0, todaySpent) / safePerDay) * 100));
  }, [todaySpent, safePerDay]);
  const savePlan = useMemo(() => {
    const savePerDay = Math.max(1, safePerDay * 0.25);
    const inThreeDays = savePerDay * 3;
    const foodBudget = Math.max(2, (Math.max(0, todayRemaining) + inThreeDays) * 0.35);
    return { savePerDay, inThreeDays, foodBudget };
  }, [safePerDay, todayRemaining]);
  const morningCoachBriefing = useMemo(() => {
    const preferredName = settings?.profileName?.trim() || "Guled Abdi";
    const greeting = currentHour < 12 ? "Good morning" : currentHour < 17 ? "Good afternoon" : "Good evening";
    const dayPart = format(new Date(), "EEEE");
    const budgetLine = todayRemaining >= 0
      ? `You've got about ${money(todayRemaining)} to work with today — solid room if you stay intentional.`
      : `You're about ${money(Math.abs(todayRemaining))} over today's target, but you can still recover with one tight spending choice.`;
    const taskMealLine = tasks.length === 0 && mealStats.planned === 0
      ? "No tasks or meals locked in yet — that's not empty, that's open space to shape your day."
      : `You're at ${doneTasks}/${tasks.length || 0} tasks and ${mealStats.completed}/${mealStats.planned || 0} meals — keep the rhythm steady.`;
    const timelineLine = timelineEvents.length === 0
      ? "Your timeline is clear right now, which means you can claim the best hours before they disappear."
      : `You've got ${timelineEvents.length} timeline block(s) — keep your next block protected.`;
    const somalilandLine = fallbackHeadline
      ? "Somaliland is already moving this morning — stay informed, but keep your focus tight."
      : "Somaliland morning energy is calm right now — perfect time to make your first strong move.";
    const nudge = tasks.length === 0
      ? "One move: write one priority before 9am and finish it first."
      : "One move: finish your top task before you check socials again.";
    const combined = `${greeting}, ${preferredName}. ${dayPart} is here — make it count. ${budgetLine} ${taskMealLine} ${timelineLine} ${somalilandLine} ${nudge}`;
    return combined.split(/\s+/).slice(0, 80).join(" ");
  }, [settings?.profileName, currentHour, todayRemaining, tasks.length, doneTasks, mealStats.planned, mealStats.completed, timelineEvents.length, fallbackHeadline]);
  const refreshApp = async () => {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        registration.active?.postMessage({ type: "CLEAR_CACHES" });
        await registration.update();
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    const hardUrl = `${window.location.pathname}?refresh=${Date.now()}${window.location.hash}`;
    window.location.replace(hardUrl);
  };

  const enableNotifications = async () => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setNotifState("unsupported");
      setPushStatusDetail("Notifications are not supported on this browser/device.");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotifState(permission as "default" | "granted" | "denied");
    if (permission !== "granted") {
      setPushConnected(false);
      setPushStatusDetail("Permission not granted.");
      return;
    }
    const preferredName = settings?.profileName?.trim() || "there";

    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: "UPDATE_NOTIFICATION_DATA", payload: { upcomingCount: upcoming.length } });
    await registration.showNotification("Zero notifications enabled", {
      body: `Hi ${preferredName}, I will remind you about upcoming bills and daily money check-ins.`,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "zero-enabled",
    });

    const periodic = (registration as ServiceWorkerRegistration & {
      periodicSync?: { register: (tag: string, options: { minInterval: number }) => Promise<void> };
    }).periodicSync;
    if (periodic?.register) {
      await periodic.register("zero-daily-check", { minInterval: 24 * 60 * 60 * 1000 });
    }
    await subscribeUser();
  };

  const subscribeUser = async () => {
    if (!("serviceWorker" in navigator)) {
      setPushConnected(false);
      setPushStatusDetail("Service worker is not available on this browser/device.");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      if (!("pushManager" in registration)) {
        setPushConnected(false);
        setPushStatusDetail("PushManager not available. On iPhone, install as Home Screen app and allow notifications.");
        return;
      }
      const keyResponse = await fetch("/api/push/public-key");
      if (!keyResponse.ok) {
        setPushConnected(false);
        setPushStatusDetail("Push key endpoint unavailable. Start the Express server (`npm run start`) and check VAPID env vars.");
        return;
      }
      const keyData = await keyResponse.json();
      if (!keyData?.publicKey) {
        setPushConnected(false);
        setPushStatusDetail("Server did not return a VAPID public key.");
        return;
      }
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(String(keyData.publicKey)),
        });
      }
      const syncRes = await fetch("/api/save-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription,
        }),
      });
      if (syncRes.ok) {
        setPushConnected(true);
        setPushStatusDetail("Connected successfully.");
      } else {
        const errorBody = await syncRes.json().catch(() => ({}));
        setPushConnected(false);
        setPushStatusDetail(String(errorBody?.error || "Server rejected push subscription."));
      }
    } catch {
      setPushConnected(false);
      setPushStatusDetail("Failed to create push subscription on this device.");
    }
  };

  const testNotification = async () => {
    if (!("serviceWorker" in navigator)) return;
    const preferredName = settings?.profileName?.trim() || "there";
    try {
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: preferredName,
          upcomingCount: upcoming.length,
        }),
      });
      if (response.ok) {
        setPushConnected(true);
        setPushStatusDetail("Connected successfully.");
        return;
      }
      const errorBody = await response.json().catch(() => ({}));
      setPushStatusDetail(String(errorBody?.error || "Push test failed on server."));
    } catch {
      // fallback to local notification below
      setPushStatusDetail("Push server not reachable. Sent local notification fallback.");
    }
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("Zero reminder", {
      body: `Hi ${preferredName}, you have ${upcoming.length} upcoming bill(s). Open Zero for details.`,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "zero-test",
    });
  };
  const scheduleTestNotification = () => {
    if (notifState !== "granted") return;
    const parsed = Number(testNotifDelaySec);
    const delaySec = Math.max(1, Math.min(3600, Number.isFinite(parsed) ? Math.floor(parsed) : 10));
    const preferredName = settings?.profileName?.trim() || "there";
    setTestNotifDelaySec(String(delaySec));
    if (scheduledNotifTimeoutRef.current) {
      window.clearTimeout(scheduledNotifTimeoutRef.current);
    }
    const fireAt = Date.now() + delaySec * 1000;
    setScheduledNotifAt(fireAt);
    void fetch("/api/schedule-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Zero reminder",
        body: `you have ${upcoming.length} upcoming bill(s). Open Zero for details.`,
        displayName: preferredName,
        delaySeconds: delaySec,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        setPushStatusDetail("Server schedule failed. Keeping local timer fallback.");
        scheduledNotifTimeoutRef.current = window.setTimeout(() => {
          void testNotification();
          setScheduledNotifAt(null);
          scheduledNotifTimeoutRef.current = null;
        }, delaySec * 1000);
        return;
      }
      setPushStatusDetail(`Notification scheduled on server in ${delaySec}s.`);
      scheduledNotifTimeoutRef.current = window.setTimeout(() => {
        setScheduledNotifAt(null);
        scheduledNotifTimeoutRef.current = null;
      }, delaySec * 1000);
    }).catch(() => {
      setPushStatusDetail("Server schedule unreachable. Keeping local timer fallback.");
      scheduledNotifTimeoutRef.current = window.setTimeout(() => {
        void testNotification();
        setScheduledNotifAt(null);
        scheduledNotifTimeoutRef.current = null;
      }, delaySec * 1000);
    });
  };
  const applyTemplateToToday = () => {
    if (routineTemplate.length === 0) return;
    const mapped: TimelineEvent[] = routineTemplate.map((block) => ({
      id: Date.now() + Math.floor(Math.random() * 1000) + block.id,
      title: block.name,
      hour: block.hour,
      durationMinutes: block.durationMinutes,
      category: block.category,
    }));
    setTimelineEvents(mapped.sort((a, b) => a.hour - b.hour));
  };
  const savePlanAheadItem = async (item: PlanAheadItem) => {
    if (item.id) {
      await db.table("routinePlans").put(item);
    } else {
      await db.table("routinePlans").add(item);
    }
    const rows = await db.table("routinePlans").toArray();
    setPlanAheadItems(rows as PlanAheadItem[]);
  };
  const deletePlanAheadItem = async (id?: number) => {
    if (!id) return;
    await db.table("routinePlans").delete(id);
    const rows = await db.table("routinePlans").toArray();
    setPlanAheadItems(rows as PlanAheadItem[]);
  };
  const scheduleReminderItem = async (item: RoutineReminderItem) => {
    if (!item.enabled) return;
    try {
      await fetch("/api/schedule-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: item.label,
          body: `Routine reminder: ${item.label}`,
          displayName: settings?.profileName || "there",
          delaySeconds: item.delaySeconds,
        }),
      });
    } catch {
      // ignore schedule failures here
    }
  };
  const sendAiNotification = async () => {
    if (!coachNudgesEnabled) {
      setPushStatusDetail("Enable Coach nudges toggle first.");
      return;
    }
    if (notifState !== "granted") {
      setPushStatusDetail("Enable notifications first.");
      return;
    }
    const lastAssistant = [...chat].reverse().find((msg) => msg.role === "assistant");
    const preferredName = settings?.profileName?.trim() || "there";
    if (!lastAssistant) {
      setPushStatusDetail("No Coach Zero message found yet.");
      return;
    }
    const response = await fetch("/api/send-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Coach Zero for ${preferredName}`,
        body: lastAssistant.text.slice(0, 180),
        displayName: preferredName,
      }),
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      setPushStatusDetail(String(errorBody?.error || "Failed to send AI notification."));
      return;
    }
    setPushStatusDetail("Coach Zero notification sent.");
  };
  const runAssistantAutomation = async (question: string) => {
    const notes: string[] = [];
    const preferredName = settings?.profileName?.trim() || "there";
    const text = question.toLowerCase();
    const asksReminder = /remind me|set reminder|schedule reminder|routine reminder/.test(text);
    const asksNotification = /notify me now|send (me )?a notification|ping me/.test(text);
    if ((asksReminder || asksNotification) && notifState !== "granted") {
      const note = "Notifications are not enabled yet. Please enable notifications first.";
      notes.push(note);
      setPushStatusDetail(note);
      return notes;
    }
    if (asksReminder) {
      let delaySeconds = 1800;
      const hourMatch = question.match(/(\d+)\s*(hour|hours|hr|hrs)/i);
      const minuteMatch = question.match(/(\d+)\s*(minute|minutes|min|mins)/i);
      if (hourMatch) delaySeconds = Math.max(60, Number(hourMatch[1]) * 3600);
      else if (minuteMatch) delaySeconds = Math.max(60, Number(minuteMatch[1]) * 60);
      const messageMatch = question.match(/(?:to|about)\s+(.+)$/i);
      const reminderMessage = messageMatch?.[1]?.trim() || routineReminderBody;
      const response = await fetch("/api/schedule-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Coach Zero reminder",
          body: reminderMessage,
          displayName: preferredName,
          delaySeconds,
        }),
      });
      if (response.ok) {
        const note = `Reminder scheduled in ${Math.max(1, Math.round(delaySeconds / 60))} min.`;
        notes.push(note);
        setPushStatusDetail(note);
      } else {
        const errorBody = await response.json().catch(() => ({}));
        const note = String(errorBody?.error || "Failed to schedule reminder.");
        notes.push(note);
        setPushStatusDetail(note);
      }
    }
    if (asksNotification) {
      const response = await fetch("/api/send-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Coach Zero for ${preferredName}`,
          body: "Quick nudge: review your priorities and stay on target today.",
          displayName: preferredName,
        }),
      });
      if (response.ok) {
        const note = "Notification sent to your device.";
        notes.push(note);
        setPushStatusDetail(note);
      } else {
        const errorBody = await response.json().catch(() => ({}));
        const note = String(errorBody?.error || "Failed to send notification.");
        notes.push(note);
        setPushStatusDetail(note);
      }
    }
    return notes;
  };
  const reconnectPush = async () => {
    if (!("serviceWorker" in navigator)) {
      setPushConnected(false);
      setPushStatusDetail("Service worker is not available on this browser/device.");
      return;
    }
    if (notifState !== "granted") {
      await enableNotifications();
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      if (!("pushManager" in registration)) {
        setPushConnected(false);
        setPushStatusDetail("PushManager not available. On iPhone, install as Home Screen app and allow notifications.");
        return;
      }
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        try {
          await fetch("/api/push/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          });
        } catch {
          // continue local unsubscribe even if server call fails
        }
        await existing.unsubscribe();
      }
      setPushConnected(false);
      setPushStatusDetail("Old push subscription removed. Reconnecting...");
      await enableNotifications();
    } catch {
      setPushConnected(false);
      setPushStatusDetail("Reconnect failed. Try again after refreshing the app.");
    }
  };

  const askAssistant = async (question: string) => {
    if (!question.trim() || !settings) return;
    const text = question.trim();
    const historyBeforeQuestion = [...chat].slice(-10) as Array<{ role: "assistant" | "user"; text: string }>;
    const nextHistory = [...historyBeforeQuestion, { role: "user", text }] as Array<{ role: "assistant" | "user"; text: string }>;
    setChat(nextHistory);
    setAssistantBusy(true);
    try {
      const actionNotes = await runAssistantAutomation(text);
      let streamedAnswer = "";
      let streamMounted = false;
      const answer = await askGroqFinanceAssistant({
        question: text,
        chatHistory: historyBeforeQuestion,
        transactions,
        subscriptions,
        settings,
        forecastData,
        financeSnapshot: {
          monthlySalary,
          currentBalance: realBalance,
          monthlyRealBalance,
          weeklySafeToUse,
          dailyAllowance: safePerDay,
          todaySpent,
          todayRemaining,
          weeklySpent,
          weeklyIncome,
          weeklyUpcomingSubs,
        },
        routineSnapshot: {
          userName: (settings.profileName || "there").trim() || "there",
          currentBlock: currentTimelineBlock
            ? {
              title: currentTimelineBlock.title,
              category: currentTimelineBlock.category,
              minutesLeft: currentTimelineBlock.minutesLeft,
            }
            : null,
          todayTimeline: sortedTimelineEvents.map((e) => ({
            hour: e.hour,
            title: e.title,
            category: e.category,
            durationMinutes: e.durationMinutes,
          })),
          checklist: {
            completedCount: doneTasks,
            totalCount: tasks.length,
            tasks: tasks.map((t) => ({ title: t.title, priority: t.priority, done: t.done })),
          },
          templateBlocks: routineTemplate.map((b) => ({
            hour: b.hour,
            name: b.name,
            category: b.category,
            durationMinutes: b.durationMinutes,
          })),
          planAhead: {
            tomorrow: tomorrowPlans.map((i) => ({
              dayLabel: format(new Date(i.date), "EEE"),
              hour: i.hour,
              title: i.title,
              category: i.category,
            })),
            laterThisWeek: laterWeekPlans.map((i) => ({
              dayLabel: format(new Date(i.date), "EEE"),
              hour: i.hour,
              title: i.title,
              category: i.category,
            })),
          },
          activeReminders: routineReminders.map((r) => ({
            label: r.label,
            delaySeconds: r.delaySeconds,
            enabled: r.enabled,
          })),
          timeOfDay: currentHour < 12 ? "morning" : currentHour < 17 ? "afternoon" : currentHour < 22 ? "evening" : "night",
        },
        onToken: (chunk) => {
          streamedAnswer += chunk;
          if (!streamMounted) {
            streamMounted = true;
            setChat((c) => [...c, { role: "assistant", text: chunk }]);
            return;
          }
          setChat((c) => {
            if (c.length === 0) return [{ role: "assistant", text: chunk }];
            const last = c[c.length - 1];
            if (last.role !== "assistant") return [...c, { role: "assistant", text: chunk }];
            return [...c.slice(0, -1), { ...last, text: last.text + chunk }];
          });
        },
      });
      setAssistantEngine("groq");
      setAssistantEngineReason("");
      const base = streamedAnswer.trim() || answer;
      const withActions = actionNotes.length > 0 ? `${base}\n\nActions completed:\n- ${actionNotes.join("\n- ")}` : base;
      setChat((c) => {
        const copy = [...c];
        for (let i = copy.length - 1; i >= 0; i -= 1) {
          if (copy[i].role === "assistant") {
            copy[i] = { ...copy[i], text: withActions };
            return copy;
          }
        }
        return [...copy, { role: "assistant", text: withActions }];
      });
    } catch (error) {
      const fallback = askFinanceAssistant(text, transactions, subscriptions, settings, forecastData);
      setAssistantEngine("fallback");
      setAssistantEngineReason(error instanceof Error ? error.message : "Unknown Groq error");
      setChat((c) => [...c, { role: "assistant", text: fallback }]);
    } finally {
      setAssistantBusy(false);
    }
  };

  useEffect(() => {
    if (!("Notification" in window)) {
      setNotifState("unsupported");
      return;
    }
    setNotifState(Notification.permission as "default" | "granted" | "denied");
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("zero_routine_notified_v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, 1>;
      if (parsed && typeof parsed === "object") routineNotificationCacheRef.current = parsed;
    } catch {
      // ignore corrupt cache
    }
  }, []);
  useEffect(() => {
    if (notifState !== "granted") return;
    void subscribeUser();
  }, [notifState]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then((registration) => {
      registration.pushManager.getSubscription().then((subscription) => {
        const hasSubscription = Boolean(subscription);
        setPushConnected(hasSubscription);
        if (hasSubscription) {
          setPushStatusDetail("Device has a local push subscription.");
        }
      }).catch(() => {
        setPushConnected(false);
        setPushStatusDetail("Could not read push subscription from service worker.");
      });
    });
  }, []);
  useEffect(() => {
    if (!scheduledNotifAt) return;
    const id = window.setInterval(() => {
      setTimerNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [scheduledNotifAt]);
  useEffect(() => {
    if (!showReminderSheet) return;
    const id = window.setTimeout(() => setShowReminderSheet(false), 2200);
    return () => window.clearTimeout(id);
  }, [showReminderSheet]);
  useEffect(() => {
    return () => {
      if (scheduledNotifTimeoutRef.current) {
        window.clearTimeout(scheduledNotifTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then((registration) => {
      registration.active?.postMessage({
        type: "UPDATE_NOTIFICATION_DATA",
        payload: { upcomingCount: upcoming.length },
      });
    });
  }, [upcoming.length]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let reloading = false;

    const forceReload = () => {
      if (reloading) return;
      reloading = true;
      const url = `${window.location.pathname}?refresh=${Date.now()}${window.location.hash}`;
      window.location.replace(url);
    };

    const attachUpdateHandler = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            installing.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    };

    navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration) return;
      attachUpdateHandler(registration);
      void registration.update();
    });

    navigator.serviceWorker.ready.then((registration) => {
      attachUpdateHandler(registration);
    });

    navigator.serviceWorker.addEventListener("controllerchange", forceReload);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      navigator.serviceWorker.getRegistration().then((registration) => {
        if (!registration) return;
        void registration.update();
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    const updateInterval = window.setInterval(() => {
      navigator.serviceWorker.getRegistration().then((registration) => {
        if (!registration) return;
        void registration.update();
      });
    }, 60_000);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", forceReload);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(updateInterval);
    };
  }, []);

  if (loading || !settings) return <div className="screen"><div className="skeleton large" /><div className="skeleton" /><div className="skeleton" /></div>;

  return (
    <div className="app-shell">
      <header className="top">
        <div>
          <p className="muted">Consistency streak</p>
          <div className="streak-wrap">
            <motion.span
              className="streak-icon"
              animate={{ y: [0, -2, 0], scale: [1, 1.08, 1] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
              aria-hidden="true"
            >
              <IosIcon name="streak" />
            </motion.span>
            <motion.h1
              key={streakDays}
              initial={{ opacity: 0.4, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 250, damping: 16 }}
            >
              {streakDays} day{streakDays === 1 ? "" : "s"}
            </motion.h1>
          </div>
        </div>
        <p className="muted">{format(new Date(), "EEEE, MMM d")}</p>
      </header>

      <main className="content">
        {tab === "Home" && (
          <div className="home-layout">
            <section className="home-intro news-card">
              <div className="row">
                <div>
                  <p className="home-kicker">Somaliland brief</p>
                  <h2 className="home-title">Top News</h2>
                </div>
                <button type="button" className="news-live-dot" onClick={() => { void refreshNews(); }}>
                  {newsLoading ? "Loading..." : "Refresh news"}
                </button>
              </div>
              {!newsLoading && newsItems.length === 0 && !newsError && (
                <p className="muted">Tap “Refresh news” to load the latest Somaliland headlines.</p>
              )}
              {newsLoading && <p className="muted">Loading latest headlines...</p>}
              {!newsLoading && newsError && <p className="muted">{newsError}</p>}
              {!newsLoading && !newsError && newsItems.length > 0 && (
                <button
                  type="button"
                  className="news-hot-item"
                  onClick={() => window.open((latestNewsIsFresh ? latestNews : fallbackHeadline).url, "_blank", "noopener,noreferrer")}
                >
                  <span className="news-hot-label">{latestNewsIsFresh ? "Latest news" : "Hot headline"}</span>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.strong
                      key={(latestNewsIsFresh ? latestNews : fallbackHeadline).url}
                      className="news-hot-title"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.25 }}
                    >
                      {(latestNewsIsFresh ? latestNews : fallbackHeadline).title}
                    </motion.strong>
                  </AnimatePresence>
                  <span className="muted">{(latestNewsIsFresh ? latestNews : fallbackHeadline).source}</span>
                </button>
              )}
            </section>
            <section className="home-intro briefing-card">
              <div className="briefing-head">
                <div>
                  <p className="home-kicker">Daily briefing</p>
                  <h2 className="home-title">Today at a glance</h2>
                </div>
                <span className="briefing-score">{overallScore}% focus</span>
              </div>
              <p className="briefing-summary">
                {dailyBriefing.openTasks > 0
                  ? `${dailyBriefing.openTasks} task(s) still open. Lock your top one now and protect your spending pace.`
                  : "Tasks are clear. Keep your money pace steady and finish the day strong."}
              </p>
              <div className="briefing-grid">
                <article className="briefing-item money">
                  <p className="muted">Money pace</p>
                  <strong className={todayRemaining < 0 ? "negative" : "positive"}>
                    {todayRemaining < 0 ? `${money(Math.abs(todayRemaining))} over` : `${money(todayRemaining)} left`}
                  </strong>
                  <span className="muted">{dailyBriefing.moneySignal}</span>
                </article>
                <article className="briefing-item">
                  <p className="muted">Tasks</p>
                  <strong>{dailyBriefing.taskSignal}</strong>
                  <span className="muted">{dailyBriefing.openTasks} open</span>
                </article>
                <article className="briefing-item">
                  <p className="muted">Savings</p>
                  <strong>{money(savePlan.savePerDay)}</strong>
                  <span className="muted">daily save target</span>
                </article>
                <article className="briefing-item">
                  <p className="muted">Bills (3d)</p>
                  <strong>{dailyBriefing.nextBills}</strong>
                  <span className="muted">upcoming reminders</span>
                </article>
              </div>
            </section>

            <div className="home-section-head">
              <h3>Top numbers</h3>
              <p className="muted">Updated with every transaction</p>
            </div>
            <section className="card main-card">
              <p className="muted">Weekly Safe to Use</p>
              <button type="button" className="amount-reveal-btn" onClick={() => setShowWeeklySafe((v) => !v)}>
                <AnimatePresence mode="wait" initial={false}>
                  {showWeeklySafe ? (
                    <motion.h2
                      key="weekly-shown"
                      initial={{ opacity: 0, y: 6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.98 }}
                      transition={{ duration: 0.2 }}
                    >
                      {money(weeklySafeToUse)}
                    </motion.h2>
                  ) : (
                    <motion.h2
                      key="weekly-hidden"
                      className="amount-hidden"
                      initial={{ opacity: 0, y: 6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.98 }}
                      transition={{ duration: 0.2 }}
                    >
                      ****
                    </motion.h2>
                  )}
                </AnimatePresence>
              </button>
              <p className="muted">{showWeeklySafe ? "Tap amount to hide" : "Tap amount to reveal"}</p>
            </section>
            <section className="credit-card">
              <div className="credit-card-top">
                <p className="muted">Zero Card</p>
                <span className="chip" aria-hidden="true" />
              </div>
              <p className="credit-card-balance-label">Monthly real balance</p>
              <button type="button" className="credit-card-balance amount-reveal-btn" onClick={() => setShowMonthlyBalance((v) => !v)}>
                <AnimatePresence mode="wait" initial={false}>
                  {showMonthlyBalance ? (
                    <motion.span
                      key="monthly-shown"
                      initial={{ opacity: 0, y: 6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.98 }}
                      transition={{ duration: 0.2 }}
                    >
                      {money(monthlyRealBalance)}
                    </motion.span>
                  ) : (
                    <motion.span
                      key="monthly-hidden"
                      className="amount-hidden"
                      initial={{ opacity: 0, y: 6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.98 }}
                      transition={{ duration: 0.2 }}
                    >
                      ****
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
            </section>

            <div className="home-section-head">
              <h3>Weekly progress</h3>
              <p className="muted">Soft guidance, no strict warnings</p>
            </div>
            <section className="card daily-goal-card">
              <div className="daily-allowance-head">
                <div>
                  <p className="muted">Daily allowance goal</p>
                  <h3>{money(safePerDay)}</h3>
                </div>
                <span className="goal-pill">{allowanceProgressPct.toFixed(0)}% used</span>
              </div>
              <p className="muted">Based on your monthly real balance spread across remaining month days.</p>
              <div className="daily-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={allowanceProgressPct}>
                <div className="daily-progress-fill" style={{ width: `${allowanceProgressPct}%` }} />
              </div>
              <div className="daily-allowance-grid">
                <article><p className="muted">Spent today</p><strong>{money(todaySpent)}</strong></article>
                <article><p className="muted">Left for today</p><strong className={todayRemaining < 0 ? "negative" : "positive"}>{money(todayRemaining)}</strong></article>
                <article><p className="muted">Save daily (3-day plan)</p><strong>{money(savePlan.savePerDay)}</strong></article>
                <article><p className="muted">Extra buffer in 3 days</p><strong className="positive">{money(savePlan.inThreeDays)}</strong></article>
                <article><p className="muted">Food budget after 3 days</p><strong>{money(savePlan.foodBudget)}</strong></article>
                <article><p className="muted">Bills due this week</p><strong>{money(weeklyUpcomingSubs)}</strong></article>
              </div>
              <p className="daily-tip">{smartSavingsTip}</p>
            </section>

            <div className="home-section-head">
              <h3>Recent activity</h3>
              <p className="muted">Swipe to edit or delete</p>
            </div>
            <section className="card">
              <h3>Recent transactions</h3>
              {transactions.slice(0, 5).map((t) => <TransactionRow key={t.id} tx={t} onDelete={() => deleteTransaction(t.id!)} onEdit={() => { setEditingTx(t); setShowTx(true); }} />)}
            </section>

            <div className="home-section-head">
              <h3>Spending calendar</h3>
              <p className="muted">{format(new Date(), "MMMM yyyy")}</p>
            </div>
            <section className="card">
              <div className="calendar-weekdays">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => <span key={w}>{w}</span>)}
              </div>
              <div className="calendar-grid">
                {spendingCalendar.map((cell) => {
                  if (cell.blank) return <div key={cell.key} className="calendar-cell blank" />;
                  const fullCell = cell as { key: string; blank: false; day: string; amount: number; today: boolean };
                  return (
                    <button
                      key={fullCell.key}
                      type="button"
                      className={`calendar-cell ${fullCell.today ? "today" : ""} ${selectedCalendarDay === fullCell.key ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedCalendarDay(fullCell.key);
                        setShowCalendarDaySheet(true);
                      }}
                    >
                      <span className="day">{fullCell.day}</span>
                      <span className={`amt ${fullCell.amount > 0 ? "spent" : ""}`}>
                        {fullCell.amount > 0 ? money(fullCell.amount) : "-"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {tab === "Transactions" && (
          <section className="card">
            <div className="row">
              <h3>Transactions</h3>
              <div className="inline-actions">
                <button onClick={() => setShowBulkTx(true)}>Bulk add</button>
                <button onClick={() => setShowTx(true)}>Add</button>
              </div>
            </div>
            {transactions.map((t) => <TransactionRow key={t.id} tx={t} onDelete={() => deleteTransaction(t.id!)} onEdit={() => { setEditingTx(t); setShowTx(true); }} />)}
          </section>
        )}

        {tab === "Subscriptions" && (
          <section className="card">
            <div className="row"><h3>Subscriptions</h3><button onClick={() => setShowSub(true)}>Add</button></div>
            {upcoming.map((s) => (
              <SubscriptionRow
                key={s.id}
                label={s.name}
                amount={s.amount}
                date={s.dueDate}
                urgency={s.urgency}
                onEdit={() => {
                  setEditingSub(subscriptions.find((x) => x.id === s.id) ?? null);
                  setShowSub(true);
                }}
              />
            ))}
          </section>
        )}

        {tab === "Insights" && (
          <div className="routine-layout">
            <section className="card routine-card">
              <p className="routine-section-kicker">RIGHT NOW</p>
              {currentTimelineBlock ? (
                <div className="routine-now-card">
                  <div>
                    <h3>{currentTimelineBlock.title}</h3>
                    <p className="muted">{currentTimelineBlock.category.toUpperCase()} · {currentTimelineBlock.minutesLeft} min left</p>
                  </div>
                  <button type="button" onClick={() => { setEditingTimelineEvent(currentTimelineBlock); setShowTimelineSheet(true); }}>Edit</button>
                </div>
              ) : (
                <div className="routine-now-card">
                  <div>
                    <h3>No activity scheduled</h3>
                    <p className="muted">Add a block to anchor this hour.</p>
                  </div>
                  <button type="button" onClick={() => { setEditingTimelineEvent({ id: Date.now(), title: "", hour: currentHour, category: "work", durationMinutes: 60 }); setShowTimelineSheet(true); }}>+ Add</button>
                </div>
              )}
            </section>

            <section className="card routine-card">
              <p className="routine-section-kicker">TODAY'S TIMELINE</p>
              <div className="timeline-list">
                {routineHours.map((hour) => {
                  const event = sortedTimelineEvents.find((e) => e.hour === hour);
                  const isNow = hour === currentHour;
                  return (
                    <button key={hour} type="button" className={`timeline-hour ${isNow ? "current" : ""}`} onClick={() => {
                      setEditingTimelineEvent(event ?? { id: Date.now(), title: "", hour, category: "work", durationMinutes: 60 });
                      setShowTimelineSheet(true);
                    }}>
                      <div className="timeline-hour-label">
                        <span>{hour > 12 ? `${hour - 12}pm` : hour === 12 ? "12pm" : `${hour}am`}</span>
                        {isNow && <span className="timeline-now">NOW</span>}
                      </div>
                      <div className="timeline-hour-events">
                        {event ? (
                          <div className={`timeline-event ${event.category}`}>
                            <span>{event.title}</span>
                            <small>{event.durationMinutes ?? 60}m</small>
                          </div>
                        ) : (
                          <div className="timeline-empty">+ Add activity</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="card routine-card">
              <p className="routine-section-kicker">DAILY CHECKLIST</p>
              <div className="row">
                <h3>Today's tasks</h3>
                <span className="badge">{doneTasks} of {tasks.length} done</span>
              </div>
              {todayChecklist.map((task) => (
                <div key={task.id} className="routine-row">
                  <label className="routine-check-item">
                    <input type="checkbox" checked={task.done} onChange={() => setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, done: !t.done } : t))} />
                    <span style={{ textDecoration: task.done ? "line-through" : "none" }}>{task.title}</span>
                  </label>
                  <span className="routine-check-pill">{task.priority}</span>
                </div>
              ))}
            </section>

            <section className="card routine-card">
              <p className="routine-section-kicker">ROUTINE TEMPLATE</p>
              <div className="row">
                <h3>Ideal day blocks</h3>
                <div className="inline-actions">
                  <button type="button" onClick={applyTemplateToToday}>Apply Template to Today</button>
                  <button type="button" className="ghost-btn" onClick={() => { setEditingTemplateBlock({ id: Date.now(), name: "", hour: 7, durationMinutes: 60, category: "personal" }); setShowTemplateSheet(true); }}>+ Add</button>
                </div>
              </div>
              {routineTemplate.map((block) => (
                <div key={block.id} className={`timeline-event ${block.category}`}>
                  <span>{block.hour > 12 ? `${block.hour - 12}pm` : block.hour === 12 ? "12pm" : `${block.hour}am`} · {block.name} ({block.durationMinutes}m)</span>
                  <div className="inline-actions">
                    <button type="button" className="ghost-btn" onClick={() => { setEditingTemplateBlock(block); setShowTemplateSheet(true); }}>Edit</button>
                    <button type="button" className="ghost-btn" onClick={() => setRoutineTemplate((prev) => prev.filter((x) => x.id !== block.id))}>Delete</button>
                  </div>
                </div>
              ))}
            </section>

            <section className="card routine-card">
              <p className="routine-section-kicker">PLAN AHEAD</p>
              <div className="row">
                <h3>Tomorrow & this week</h3>
                <button type="button" className="ghost-btn" onClick={() => { setEditingPlanAheadItem({ date: tomorrowLabel, title: "", hour: 9, category: "work", createdAt: new Date().toISOString() }); setShowPlanAheadSheet(true); }}>+ Add</button>
              </div>
              <p className="muted">Tomorrow</p>
              {tomorrowPlans.map((item) => (
                <div key={item.id} className={`timeline-event ${item.category}`}>
                  <span>{item.hour > 12 ? `${item.hour - 12}pm` : item.hour === 12 ? "12pm" : `${item.hour}am`} · {item.title}</span>
                  <div className="inline-actions">
                    <button type="button" className="ghost-btn" onClick={() => { setEditingPlanAheadItem(item); setShowPlanAheadSheet(true); }}>Edit</button>
                    <button type="button" className="ghost-btn" onClick={() => { void deletePlanAheadItem(item.id); }}>Delete</button>
                  </div>
                </div>
              ))}
              <p className="muted">Later this week</p>
              {laterWeekPlans.map((item) => (
                <div key={item.id} className={`timeline-event ${item.category}`}>
                  <span>{format(new Date(item.date), "EEE")} · {item.hour > 12 ? `${item.hour - 12}pm` : item.hour === 12 ? "12pm" : `${item.hour}am`} · {item.title}</span>
                </div>
              ))}
            </section>

            <section className="card routine-card">
              <p className="routine-section-kicker">REMINDERS</p>
              {routineReminders.map((item) => (
                <article key={item.id} className="routine-reminder-item">
                  <div className="routine-reminder-left">
                    <span className="routine-reminder-icon">🔔</span>
                    <div>
                      <h3>{item.label}</h3>
                      <p className="muted">In {Math.max(1, Math.round(item.delaySeconds / 60))} min</p>
                    </div>
                  </div>
                  <label className="ios-switch">
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={(e) => {
                        const next = { ...item, enabled: e.target.checked };
                        setRoutineReminders((prev) => prev.map((x) => x.id === item.id ? next : x));
                        if (e.target.checked) void scheduleReminderItem(next);
                      }}
                    />
                    <span />
                  </label>
                </article>
              ))}
              <button type="button" className="routine-add-reminder" onClick={() => { setEditingRoutineReminder({ id: Date.now(), label: "Routine reminder", delaySeconds: 1800, enabled: true }); setShowRoutineReminderSheet(true); }}>
                + Add Reminder
              </button>
            </section>
          </div>
        )}

        {tab === "Settings" && (
          <div className="settings-layout">
            <section className="card settings-card">
              <p className="settings-kicker">Financial profile</p>
              <h3>Money setup</h3>
              <div className="settings-input-grid">
                <label>Name<input value={settings.profileName ?? ""} onChange={(e) => updateSettings({ profileName: e.target.value })} placeholder="e.g. Guled" /></label>
                <label>Monthly salary<input type="number" value={settings.monthlySalary ?? 0} onChange={(e) => updateSettings({ monthlySalary: Number(e.target.value) })} /></label>
                <label>Current balance<input type="number" value={settings.currentBalance} onChange={(e) => updateSettings({ currentBalance: Number(e.target.value) })} /></label>
                <label>Monthly savings reserve<input type="number" value={settings.reservedSavings} onChange={(e) => updateSettings({ reservedSavings: Number(e.target.value) })} /></label>
              </div>
              <div className="settings-formula">
                <p className="muted">Weekly safe (from current balance): {money(weeklySafeToUse)}</p>
                <p className="muted">
                  Monthly real balance: {money(realBalance)} - {money(budgetSnapshot.remainingMonthSubscriptions)}
                </p>
                <p className="muted">Income this month: {money(budgetSnapshot.monthIncomeToDate)} of {money(monthlySalary)} planned.</p>
                <p className="muted">Week starts Saturday. {budgetSnapshot.daysLeftInWeek} day(s) left this week, {budgetSnapshot.daysLeftInMonth} day(s) left this month.</p>
              </div>
            </section>

            <section className="card settings-card">
              <p className="settings-kicker">Notifications</p>
              <h3>Alerts and reminders</h3>
              <div className="settings-actions">
                <button type="button" onClick={() => { void enableNotifications(); }}>Enable notifications</button>
                <button type="button" className="ghost-btn" onClick={() => { void testNotification(); }} disabled={notifState !== "granted"}>
                  Test notification
                </button>
                <button type="button" className="ghost-btn" onClick={() => { void reconnectPush(); }}>
                  Reconnect push
                </button>
              </div>
              <div className="settings-actions">
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={testNotifDelaySec}
                  onChange={(e) => setTestNotifDelaySec(e.target.value)}
                  placeholder="Delay seconds"
                />
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={scheduleTestNotification}
                  disabled={notifState !== "granted"}
                >
                  Schedule test timer
                </button>
              </div>
              {scheduledNotifAt && (
                <p className="muted">
                  Scheduled in {Math.max(0, Math.ceil((scheduledNotifAt - timerNow) / 1000))}s
                </p>
              )}
              <p className="muted">Status: <strong>{notifState}</strong></p>
              <p className="muted">Web push: <strong>{pushConnected ? "connected" : "not connected"}</strong></p>
              {pushStatusDetail && <p className="muted">{pushStatusDetail}</p>}
            </section>

            <section className="card settings-card">
              <p className="settings-kicker">Maintenance</p>
              <h3>App tools</h3>
              <div className="settings-actions settings-actions-stack">
                <button type="button" className="ghost-btn" onClick={() => setShowMorningBriefing(true)}>Test morning briefing</button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={async () => {
                    const ok = window.confirm("Re-categorize all transactions with improved smart rules?");
                    if (!ok) return;
                    await recategorizeTransactions();
                  }}
                >
                  Re-categorize transactions
                </button>
                <button type="button" className="ghost-btn" onClick={() => { void refreshApp(); }}>Refresh app</button>
              </div>
            </section>

            <section className="card settings-card settings-danger">
              <p className="settings-kicker">Danger zone</p>
              <h3>Reset local data</h3>
              <p className="muted">This removes transactions, subscriptions, settings, and rules from this device.</p>
              <button
                className="danger-btn"
                type="button"
                onClick={async () => {
                  const ok = window.confirm("Clear all local app data? This cannot be undone.");
                  if (!ok) return;
                  await clearData();
                }}
              >
                Clear all data
              </button>
            </section>
          </div>
        )}
      </main>

      <nav className="tabbar">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} aria-label={tabMeta[t].label}>
            <span className="tab-icon" aria-hidden="true"><IosIcon name={tabMeta[t].icon} filled={tab === t} /></span>
            <span className="tab-label">{tabMeta[t].label}</span>
          </button>
        ))}
      </nav>

      <AnimatePresence>
        {showTx && (
          <TransactionSheet
            initial={editingTx}
            onClose={() => { setShowTx(false); setEditingTx(null); }}
            onSave={async (payload) => {
              if (editingTx?.id) await updateTransaction(editingTx.id, payload);
              else await addTransaction(payload);
              setShowTx(false);
              setEditingTx(null);
            }}
          />
        )}
        {showSub && (
          <SubscriptionSheet
            initial={editingSub ?? undefined}
            onClose={() => { setShowSub(false); setEditingSub(null); }}
            onSave={async (payload) => {
              if (editingSub?.id) await updateSubscription(editingSub.id, payload);
              else await addSubscription(payload);
              setShowSub(false);
              setEditingSub(null);
            }}
          />
        )}
        {showBulkTx && (
          <BulkTransactionSheet
            onClose={() => setShowBulkTx(false)}
            onSave={async (rows) => {
              await addTransactionsBulk(rows);
              setShowBulkTx(false);
            }}
          />
        )}
        {showTimelineSheet && editingTimelineEvent && (
          <RoutineBlockSheet
            title={editingTimelineEvent.title}
            hour={editingTimelineEvent.hour}
            durationMinutes={editingTimelineEvent.durationMinutes ?? 60}
            category={editingTimelineEvent.category}
            onClose={() => { setShowTimelineSheet(false); setEditingTimelineEvent(null); }}
            onSave={({ title, hour, durationMinutes, category }) => {
              setTimelineEvents((prev) => {
                const exists = prev.some((e) => e.id === editingTimelineEvent.id);
                const nextEvent: TimelineEvent = { ...editingTimelineEvent, title, hour, durationMinutes, category };
                if (exists) return prev.map((e) => e.id === editingTimelineEvent.id ? nextEvent : e);
                return [...prev, nextEvent];
              });
              setShowTimelineSheet(false);
              setEditingTimelineEvent(null);
            }}
          />
        )}
        {showTemplateSheet && editingTemplateBlock && (
          <RoutineBlockSheet
            title={editingTemplateBlock.name}
            hour={editingTemplateBlock.hour}
            durationMinutes={editingTemplateBlock.durationMinutes}
            category={editingTemplateBlock.category}
            onClose={() => { setShowTemplateSheet(false); setEditingTemplateBlock(null); }}
            onSave={({ title, hour, durationMinutes, category }) => {
              setRoutineTemplate((prev) => {
                const exists = prev.some((e) => e.id === editingTemplateBlock.id);
                const block: RoutineTemplateBlock = { ...editingTemplateBlock, name: title, hour, durationMinutes, category };
                if (exists) return prev.map((e) => e.id === editingTemplateBlock.id ? block : e);
                return [...prev, block];
              });
              setShowTemplateSheet(false);
              setEditingTemplateBlock(null);
            }}
          />
        )}
        {showPlanAheadSheet && editingPlanAheadItem && (
          <PlanAheadSheet
            item={editingPlanAheadItem}
            onClose={() => { setShowPlanAheadSheet(false); setEditingPlanAheadItem(null); }}
            onSave={(item) => {
              void savePlanAheadItem(item);
              setShowPlanAheadSheet(false);
              setEditingPlanAheadItem(null);
            }}
          />
        )}
        {showRoutineReminderSheet && editingRoutineReminder && (
          <ReminderSheet
            item={editingRoutineReminder}
            onClose={() => { setShowRoutineReminderSheet(false); setEditingRoutineReminder(null); }}
            onSave={(item) => {
              setRoutineReminders((prev) => {
                const exists = prev.some((x) => x.id === item.id);
                if (exists) return prev.map((x) => x.id === item.id ? item : x);
                return [...prev, item];
              });
              void scheduleReminderItem(item);
              setShowRoutineReminderSheet(false);
              setEditingRoutineReminder(null);
            }}
          />
        )}
        {showCalendarDaySheet && (
          <CalendarDaySheet
            day={selectedCalendarDay}
            dailyAllowance={selectedDayDailyAllowance}
            breakdown={dailyBreakdown[selectedCalendarDay]}
            transactions={selectedDayTransactions}
            onClose={() => setShowCalendarDaySheet(false)}
          />
        )}
        {showMorningBriefing && (
          <motion.div className="sheet-wrap morning-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.section className="sheet morning-sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }}>
              <div className="morning-top">
                <div className="row">
                  <div>
                    <p className="home-kicker">Good morning</p>
                    <h3>Coach Zero briefing</h3>
                  </div>
                  <button type="button" className="ghost-btn" onClick={() => setShowMorningBriefing(false)}>Close</button>
                </div>
              </div>
              <div className="morning-content">
                <p className="muted">{morningCoachBriefing}</p>
                <div className="morning-grid">
                  <article><p className="muted">Money target</p><strong>{money(safePerDay)}</strong></article>
                  <article><p className="muted">Spent today</p><strong>{money(todaySpent)}</strong></article>
                  <article><p className="muted">Tasks</p><strong>{dailyBriefing.taskSignal}</strong></article>
                  <article><p className="muted">Meals</p><strong>{dailyBriefing.mealSignal}</strong></article>
                </div>
                <div className="morning-timeline">
                  <div className="row">
                    <h4>Day timeline</h4>
                    <span className="badge">{timelineEvents.length} events</span>
                  </div>
                  {sortedTimelineEvents.slice(0, 4).map((event) => (
                    <div key={event.id} className={`timeline-event ${event.category}`}>
                      <span>{event.hour === 12 ? "12pm" : event.hour > 12 ? `${event.hour - 12}pm` : `${event.hour}am`} · {event.title}</span>
                    </div>
                  ))}
                  {sortedTimelineEvents.length === 0 && <p className="muted">Your best hours are still open. Add one intentional block in Routine.</p>}
                </div>
                <div className="morning-news">
                  <div className="row">
                    <h4>Hot Somaliland news</h4>
                    <button type="button" className="ghost-btn" onClick={() => { void refreshNews(); }}>Refresh</button>
                  </div>
                  {!newsLoading && fallbackHeadline && (
                    <button
                      type="button"
                      className="news-hot-item"
                      onClick={() => window.open((latestNewsIsFresh ? latestNews : fallbackHeadline).url, "_blank", "noopener,noreferrer")}
                    >
                      <span className="news-hot-label">{latestNewsIsFresh ? "Latest news" : "Hot headline"}</span>
                      <strong className="news-hot-title">{(latestNewsIsFresh ? latestNews : fallbackHeadline).title}</strong>
                      <span className="muted">{(latestNewsIsFresh ? latestNews : fallbackHeadline).source}</span>
                    </button>
                  )}
                  {newsLoading && <p className="muted">Loading latest Somaliland updates...</p>}
                  {!newsLoading && !fallbackHeadline && <p className="muted">No headlines yet. Tap refresh to check again.</p>}
                </div>
                <div className="morning-news">
                  <div className="row">
                    <h4>Coach Zero suggestions</h4>
                  </div>
                  <div className="suggestion-list">
                    {coachSuggestions.map((tip) => <p key={tip} className="muted">- {tip}</p>)}
                    <p className="muted">- {smartSavingsTip}</p>
                  </div>
                </div>
              </div>
              <div className="morning-coach-quick">
                <button type="button" onClick={() => { void askAssistant("Turn my briefing into 3 action steps."); setAssistantOpen(true); }}>
                  Action steps
                </button>
                <button type="button" onClick={() => { void askAssistant("Suggest 3 tasks I should add now."); setAssistantOpen(true); }}>
                  Add tasks
                </button>
                <button type="button" onClick={() => { void askAssistant("Plan my spending for today in one rule."); setAssistantOpen(true); }}>
                  Money rule
                </button>
              </div>
              <div className="morning-coach-input">
                <input
                  value={morningQuestion}
                  onChange={(e) => setMorningQuestion(e.target.value)}
                  placeholder="Ask Coach Zero while planning..."
                />
                <button
                  type="button"
                  onClick={() => {
                    if (!morningQuestion.trim()) return;
                    const q = morningQuestion.trim();
                    setMorningQuestion("");
                    void askAssistant(q);
                    setAssistantOpen(true);
                  }}
                >
                  Ask
                </button>
              </div>
              <button type="button" className="close-day-btn" onClick={() => setShowMorningBriefing(false)}>Start my day</button>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <button className="ai-fab" type="button" onClick={() => setAssistantOpen((v) => !v)}>
        <IosIcon name="ai" />
      </button>
      <AnimatePresence>
        {assistantOpen && (
          <motion.section className="ai-chat" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}>
            <div className="ai-chat-head">
              <div className="ai-chat-title-wrap">
                <p className="ai-chat-kicker">COACH ZERO</p>
                <h3>Coach Zero</h3>
                <p className="ai-chat-subtitle">{assistantBusy ? "Thinking..." : "Ready when you are."}</p>
              </div>
              <div className="ai-chat-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setChat(DEFAULT_CHAT);
                    localStorage.removeItem("zero_ai_chat_v1");
                  }}
                >
                  Clear chat
                </button>
                <button type="button" className="ai-close-btn" onClick={() => setAssistantOpen(false)}>Done</button>
              </div>
            </div>
            {assistantEngine === "fallback" && assistantEngineReason && (
              <p className="ai-engine-reason muted">{assistantEngineReason}</p>
            )}
            <div className="ai-chat-log">
              {chat.map((msg, i) => (
                <p key={`${msg.role}-${i}`} className={`ai-bubble ${msg.role}`}>
                  {msg.text}
                </p>
              ))}
              {assistantBusy && (
                <p className="ai-bubble assistant typing">
                  <span />
                  <span />
                  <span />
                </p>
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="assistant-quick">
              <button type="button" onClick={() => {
                void askAssistant("Give me today's plan in 3 steps.");
              }}>
                Today's plan
              </button>
              <button type="button" onClick={() => {
                void askAssistant("Can I spend on a meal today?");
              }}>
                Meal check
              </button>
              <button type="button" onClick={() => {
                void askAssistant("What should I avoid spending on today?");
              }}>
                Avoid list
              </button>
              <button type="button" onClick={() => { void sendAiNotification(); }}>
                Notify me
              </button>
            </div>
            <div className="assistant-input ai-input-wrap">
              <input
                value={assistantQuestion}
                onChange={(e) => setAssistantQuestion(e.target.value)}
                placeholder="Message Coach Zero..."
              />
              <button
                type="button"
                disabled={assistantBusy}
                onClick={() => {
                  if (!assistantQuestion.trim()) return;
                  const question = assistantQuestion.trim();
                  setAssistantQuestion("");
                  void askAssistant(question);
                }}
              >
                {assistantBusy ? "Thinking..." : "Ask"}
              </button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

function RoutineBlockSheet({
  title: initialTitle,
  hour: initialHour,
  durationMinutes: initialDuration,
  category: initialCategory,
  onClose,
  onSave,
}: {
  title: string;
  hour: number;
  durationMinutes: number;
  category: TimelineCategory;
  onClose: () => void;
  onSave: (payload: { title: string; hour: number; durationMinutes: number; category: TimelineCategory }) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [startTime, setStartTime] = useState(`${String(Math.max(0, Math.min(23, initialHour))).padStart(2, "0")}:00`);
  const [endTime, setEndTime] = useState(() => {
    const start = Math.max(0, Math.min(23, initialHour));
    const endHourRaw = start + Math.max(1, Math.round(initialDuration / 60));
    const endHour = Math.max(0, Math.min(23, endHourRaw));
    return `${String(endHour).padStart(2, "0")}:00`;
  });
  const [category, setCategory] = useState<TimelineCategory>(initialCategory);
  const [keepAdding, setKeepAdding] = useState(false);
  const hourNum = Math.max(0, Math.min(23, Number(startTime.split(":")[0]) || 0));
  const endHour = Math.max(0, Math.min(23, Number(endTime.split(":")[0]) || hourNum + 1));
  const durationNum = Math.max(15, (endHour - hourNum) * 60);
  const quickTemplates = [
    { label: "Wake up", hour: 6, duration: 30, category: "personal" as const },
    { label: "Workout", hour: 7, duration: 45, category: "health" as const },
    { label: "Deep work", hour: 9, duration: 120, category: "work" as const },
    { label: "Lunch", hour: 13, duration: 45, category: "personal" as const },
    { label: "Wind down", hour: 21, duration: 45, category: "health" as const },
  ];
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        const payload = {
          title: title.trim(),
          hour: hourNum,
          durationMinutes: durationNum,
          category,
        };
        onSave(payload);
        if (keepAdding) {
          setTitle("");
          const nextEnd = Math.min(23, hourNum + 1);
          setEndTime(`${String(nextEnd).padStart(2, "0")}:00`);
        }
      }}>
        <h3>Routine block</h3>
        <div className="routine-block-quicklist">
          {quickTemplates.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="ghost-btn"
              onClick={() => {
                setTitle(preset.label);
                setStartTime(`${String(preset.hour).padStart(2, "0")}:00`);
                const endPresetHour = Math.min(23, preset.hour + Math.max(1, Math.round(preset.duration / 60)));
                setEndTime(`${String(endPresetHour).padStart(2, "0")}:00`);
                setCategory(preset.category);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label>Activity<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deep work, gym, walk..." required /></label>
        <div className="routine-inline-form">
          <label>
            Start hour
            <input type="time" step={3600} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label>
            End time
            <input type="time" step={3600} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
        </div>
        <p className="muted">Duration: {Math.floor(durationNum / 60)}h {durationNum % 60}m</p>
        <div className="task-filter-row">
          {(["work", "health", "personal"] as const).map((opt) => (
            <button key={opt} type="button" className={category === opt ? "active" : ""} onClick={() => setCategory(opt)}>
              {opt}
            </button>
          ))}
        </div>
        <label className="routine-check-item">
          <input type="checkbox" checked={keepAdding} onChange={(e) => setKeepAdding(e.target.checked)} />
          <span>Save and keep adding blocks</span>
        </label>
        <div className="row">
          <button type="button" className="ghost-btn" onClick={onClose}>Cancel</button>
          <button type="submit">Save block</button>
        </div>
      </motion.form>
    </motion.div>
  );
}

function PlanAheadSheet({
  item,
  onClose,
  onSave,
}: {
  item: PlanAheadItem;
  onClose: () => void;
  onSave: (item: PlanAheadItem) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [date, setDate] = useState(item.date);
  const [hour, setHour] = useState(String(item.hour));
  const [category, setCategory] = useState<TimelineCategory>(item.category);
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !date) return;
        onSave({
          ...item,
          title: title.trim(),
          date,
          hour: Math.max(0, Math.min(23, Number(hour) || 0)),
          category,
          createdAt: item.createdAt || new Date().toISOString(),
        });
      }}>
        <h3>Plan ahead item</h3>
        <label>Activity<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <label>Day<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        <div className="routine-inline-form">
          <input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} placeholder="Hour" />
          <select value={category} onChange={(e) => setCategory(e.target.value as TimelineCategory)}>
            <option value="work">Work</option>
            <option value="health">Health</option>
            <option value="personal">Personal</option>
          </select>
          <button type="submit">Save</button>
        </div>
        <button type="button" className="ghost-btn" onClick={onClose}>Cancel</button>
      </motion.form>
    </motion.div>
  );
}

function ReminderSheet({
  item,
  onClose,
  onSave,
}: {
  item: RoutineReminderItem;
  onClose: () => void;
  onSave: (item: RoutineReminderItem) => void;
}) {
  const [label, setLabel] = useState(item.label);
  const [delaySeconds, setDelaySeconds] = useState(String(item.delaySeconds));
  const [enabled, setEnabled] = useState(item.enabled);
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        onSave({ ...item, label: label.trim(), delaySeconds: Math.max(60, Number(delaySeconds) || 1800), enabled });
      }}>
        <h3>Reminder</h3>
        <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} required /></label>
        <label>Delay (seconds)<input type="number" min={60} value={delaySeconds} onChange={(e) => setDelaySeconds(e.target.value)} /></label>
        <label className="routine-check-item">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Active</span>
        </label>
        <div className="row"><button type="button" className="ghost-btn" onClick={onClose}>Cancel</button><button type="submit">Save</button></div>
      </motion.form>
    </motion.div>
  );
}

function TransactionRow({ tx, onDelete, onEdit }: { tx: any; onDelete: () => void; onEdit: () => void }) {
  const cat = getCategoryDefinition(tx.category || "General");
  return (
    <motion.div className="tx-row" drag="x" dragConstraints={{ left: 0, right: 0 }} onDragEnd={(_, info) => { if (info.offset.x < -80) onDelete(); if (info.offset.x > 80) onEdit(); }}>
      <div>
        <strong className="tx-category-badge" style={{ background: cat.color.bg, color: cat.color.text, boxShadow: `inset 0 0 0 1px ${cat.color.ring}` }}>
          {tx.category}
        </strong>
        <p className="muted">{tx.note || "No note"}</p>
      </div>
      <div className={tx.type === "income" ? "positive" : "negative"}>{money(tx.amount)}</div>
    </motion.div>
  );
}

function SubscriptionRow({ label, amount, date, urgency, onEdit }: { label: string; amount: number; date: string; urgency: string; onEdit: () => void }) {
  return (
    <div className={`urgency ${urgency}`}>
      <div><strong>{label}</strong><p>{formatDistanceToNow(parseISO(date), { addSuffix: true })}</p></div>
      <div className="inline-actions">
        <strong>{money(amount)}</strong>
        <button type="button" className="ghost-btn" onClick={onEdit}>Edit</button>
      </div>
    </div>
  );
}

function TransactionSheet({ initial, onClose, onSave }: { initial?: any; onClose: () => void; onSave: (p: { amount: number; type: TxType; category?: string; note?: string; date: string }) => Promise<void> }) {
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [type, setType] = useState<TxType>(initial?.type ?? "expense");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [date, setDate] = useState(initial ? format(parseISO(initial.date), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"));
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => { e.preventDefault(); onSave({ amount: Number(amount), type, category: category || undefined, note, date: new Date(date).toISOString() }); }}>
        <h3>{initial ? "Edit transaction" : "Quick transaction"}</h3>
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-5 or 2000" required /></label>
        <label>Type<select value={type} onChange={(e) => setType(e.target.value as TxType)}><option value="expense">Expense</option><option value="income">Income</option></select></label>
        <label>Category<input value={category} onChange={(e) => setCategory(e.target.value)} list="categories" placeholder="Auto if empty" /></label>
        <datalist id="categories">{CATEGORY_NAMES.map((c) => <option key={c} value={c} />)}</datalist>
        <label>Note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" /></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save</button></div>
      </motion.form>
    </motion.div>
  );
}

function SubscriptionSheet({ initial, onClose, onSave }: { initial?: Subscription; onClose: () => void; onSave: (p: { name: string; amount: number; cycle: SubscriptionCycle; nextBillingDate: string }) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [cycle, setCycle] = useState<SubscriptionCycle>(initial?.cycle ?? "monthly");
  const [nextBillingDate, setNextBillingDate] = useState(initial ? format(parseISO(initial.nextBillingDate), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"));
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => { e.preventDefault(); onSave({ name, amount: Number(amount), cycle, nextBillingDate: new Date(nextBillingDate).toISOString() }); }}>
        <h3>{initial ? "Edit subscription" : "Add subscription"}</h3>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
        <label>Cycle<select value={cycle} onChange={(e) => setCycle(e.target.value as SubscriptionCycle)}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        <label>Next billing<input type="date" value={nextBillingDate} onChange={(e) => setNextBillingDate(e.target.value)} /></label>
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save</button></div>
      </motion.form>
    </motion.div>
  );
}

function BulkTransactionSheet({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (rows: Array<{ amount: number; type: TxType; category?: string; note?: string; date: string }>) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  const parseRows = () => {
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((line, idx) => {
      const [amountRaw, typeRaw, categoryRaw, noteRaw, dateRaw] = line.split(",").map((x) => x?.trim());
      const amount = Number(amountRaw);
      const type = (typeRaw?.toLowerCase() ?? "") as TxType;
      const validType = type === "expense" || type === "income";
      const date = dateRaw ? new Date(dateRaw) : new Date();
      if (!Number.isFinite(amount) || !validType || Number.isNaN(date.getTime())) {
        throw new Error(`Line ${idx + 1} is invalid. Format: amount,type,category,note,YYYY-MM-DD`);
      }
      return {
        amount,
        type,
        category: categoryRaw || undefined,
        note: noteRaw || undefined,
        date: date.toISOString(),
      };
    });
    return parsed;
  };

  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form
        className="sheet"
        initial={{ y: 280 }}
        animate={{ y: 0 }}
        exit={{ y: 300 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const rows = parseRows();
            await onSave(rows);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Invalid bulk input.");
          }
        }}
      >
        <h3>Bulk add transactions</h3>
        <p className="muted">One line each: amount,type,category,note,date</p>
        <textarea
          className="bulk-input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={"-5.5,expense,Food & Drink,Coffee,2026-05-05\n2200,income,Income,Salary,2026-05-01"}
          rows={7}
          required
        />
        {error && <p className="error-text">{error}</p>}
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save all</button></div>
      </motion.form>
    </motion.div>
  );
}

function CalendarDaySheet({
  day,
  dailyAllowance,
  breakdown,
  transactions,
  onClose,
}: {
  day: string;
  dailyAllowance: number;
  breakdown: { spent: number; income: number; count: number } | undefined;
  transactions: Array<{ amount: number; type: TxType; category: string; note?: string; date: string }>;
  onClose: () => void;
}) {
  const spent = breakdown?.spent || 0;
  const income = breakdown?.income || 0;
  const count = breakdown?.count || 0;
  const net = income - spent;
  const overUnder = dailyAllowance - spent;
  const needsImprovement = overUnder < 0;
  const expenseTxCount = transactions.filter((tx) => tx.type === "expense").length;
  const topCategory = transactions
    .filter((tx) => tx.type === "expense")
    .reduce<Record<string, number>>((acc, tx) => {
      acc[tx.category] = (acc[tx.category] || 0) + Math.abs(tx.amount);
      return acc;
    }, {});
  const topCategoryEntry = Object.entries(topCategory).sort((a, b) => b[1] - a[1])[0];

  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.section className="sheet calendar-day-sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }}>
        <div className="row">
          <h3>{format(parseISO(day), "EEEE, MMM d")}</h3>
          <button type="button" className="ghost-btn" onClick={onClose}>Close</button>
        </div>
        <div className="snapshot-grid day-summary-grid">
          <article><p className="muted">Spent</p><strong>{money(spent)}</strong></article>
          <article><p className="muted">Income</p><strong>{money(income)}</strong></article>
          <article><p className="muted">Net</p><strong className={net < 0 ? "negative" : "positive"}>{money(net)}</strong></article>
        </div>
        <div className="calendar-day-goal">
          <p className="muted">Daily allowance goal that day</p>
          <strong>{money(dailyAllowance)}</strong>
        </div>
        <div className="calendar-day-improve">
          <h4>How to improve</h4>
          {count === 0 ? (
            <p className="muted">No spending recorded. Keep this momentum and avoid impulse purchases to protect the weekly budget.</p>
          ) : (
            <>
              <p className="muted">
                {needsImprovement
                  ? `You were over the daily goal by ${money(Math.abs(overUnder))}.`
                  : `You stayed under the goal by ${money(Math.abs(overUnder))}.`}
              </p>
              {topCategoryEntry && (
                <p className="muted">
                  Biggest spend category: <strong>{topCategoryEntry[0]}</strong> ({money(topCategoryEntry[1])}).
                </p>
              )}
              <p className="muted">
                Action plan: cap this category to about {money(Math.max(0, dailyAllowance * 0.4))} for similar days, and keep variable spending under {money(Math.max(0, dailyAllowance))}.
              </p>
              <p className="muted">
                Quick target for next day: {expenseTxCount > 3 ? "combine small purchases into one planned spend" : "keep transaction count low and intentional"}.
              </p>
            </>
          )}
        </div>
        <p className="muted">Transactions: {count}</p>
        <div className="day-tx-list">
          {transactions.length === 0 && <p className="muted">No transactions on this day.</p>}
          {transactions.map((tx, idx) => {
            const cat = getCategoryDefinition(tx.category || "General");
            return (
              <div key={`${tx.date}-${tx.category}-${idx}`} className="day-tx-item">
                <div>
                  <strong className="tx-category-badge" style={{ background: cat.color.bg, color: cat.color.text, boxShadow: `inset 0 0 0 1px ${cat.color.ring}` }}>
                    {tx.category}
                  </strong>
                  <p className="muted">{tx.note || "No note"}</p>
                </div>
                <strong className={tx.type === "income" ? "positive" : "negative"}>{money(tx.amount)}</strong>
              </div>
            );
          })}
        </div>
      </motion.section>
    </motion.div>
  );
}

export default App;

function IosIcon({
  name,
  filled = false,
}: {
  name: "home" | "activity" | "subscriptions" | "insights" | "settings" | "ai" | "streak";
  filled?: boolean;
}) {
  if (name === "home") return filled
    ? <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 4 3.8 10.6a1 1 0 0 0-.4.8V19a2 2 0 0 0 2 2h4.7a1 1 0 0 0 1-1v-4.8h1.8V20a1 1 0 0 0 1 1h4.7a2 2 0 0 0 2-2v-7.6a1 1 0 0 0-.4-.8L12 4Z" /></svg>
    : <svg viewBox="0 0 24 24" fill="none"><path d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "activity") return filled
    ? <svg viewBox="0 0 24 24"><path fill="currentColor" d="M4.5 12a1.1 1.1 0 1 0 0 2.2h3.1c.4 0 .8-.2 1-.6l1.3-2.6 2.3 6.1c.2.5.7.8 1.2.7.5 0 .9-.4 1.1-.8l2.5-5 1 1a1 1 0 0 0 .8.3h2.7a1.1 1.1 0 1 0 0-2.2h-2.3l-1.5-1.5a1.2 1.2 0 0 0-1.9.3L13 14.4l-2.4-6.2a1.2 1.2 0 0 0-2.2 0L6.9 12H4.5Z" /></svg>
    : <svg viewBox="0 0 24 24" fill="none"><path d="M4 13h3l2-4 3 8 3-6 2 2h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "subscriptions") return filled
    ? <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="3" fill="currentColor" /><path d="M8 10h8M8 14h5" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" /></svg>
    : <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" /><path d="M8 10h8M8 14h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  if (name === "insights") return filled
    ? <svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 18.5a1 1 0 0 1-1-1V9.8a1 1 0 0 1 2 0v7.7a1 1 0 0 1-1 1Zm7 0a1 1 0 0 1-1-1V6.8a1 1 0 0 1 2 0v10.7a1 1 0 0 1-1 1Zm7 0a1 1 0 0 1-1-1v-4.8a1 1 0 1 1 2 0v4.8a1 1 0 0 1-1 1Z" /><circle cx="5" cy="8" r="1.6" fill="currentColor" /><circle cx="12" cy="5" r="1.6" fill="currentColor" /><circle cx="19" cy="11.8" r="1.6" fill="currentColor" /></svg>
    : <svg viewBox="0 0 24 24" fill="none"><path d="M5 18V9m7 9V6m7 12v-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="5" cy="8" r="1.4" fill="currentColor" /><circle cx="12" cy="5" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></svg>;
  if (name === "settings") return filled
    ? <svg viewBox="0 0 24 24"><path fill="currentColor" d="m21.1 13.3-.9-.5a8.6 8.6 0 0 0 0-1.6l1-.5a1 1 0 0 0 .4-1.3l-1-1.8a1 1 0 0 0-1.3-.4l-1 .4a7 7 0 0 0-1.4-.9l-.1-1.1a1 1 0 0 0-1-.9h-2a1 1 0 0 0-1 .9l-.1 1.1a7 7 0 0 0-1.4 1l-1-.5a1 1 0 0 0-1.3.4l-1 1.8a1 1 0 0 0 .4 1.3l1 .5a8.6 8.6 0 0 0 0 1.6l-1 .5a1 1 0 0 0-.4 1.3l1 1.8a1 1 0 0 0 1.3.4l1-.4a7 7 0 0 0 1.4.9l.1 1.1a1 1 0 0 0 1 .9h2a1 1 0 0 0 1-.9l.1-1.1a7 7 0 0 0 1.4-1l1 .5a1 1 0 0 0 1.3-.4l1-1.8a1 1 0 0 0-.4-1.3ZM12 15.5a3.5 3.5 0 1 1 0-7.1 3.5 3.5 0 0 1 0 7Z" /></svg>
    : <svg viewBox="0 0 24 24" fill="none"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke="currentColor" strokeWidth="1.8" /><path d="M19.4 14.2a1 1 0 0 0 .2 1.1l.1.1a1.2 1.2 0 0 1 0 1.7l-.5.5a1.2 1.2 0 0 1-1.7 0l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9v.2a1.2 1.2 0 0 1-1.2 1.2h-.7a1.2 1.2 0 0 1-1.2-1.2v-.2a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a1.2 1.2 0 0 1-1.7 0l-.5-.5a1.2 1.2 0 0 1 0-1.7l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6h-.2a1.2 1.2 0 0 1-1.2-1.2v-.7a1.2 1.2 0 0 1 1.2-1.2h.2a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a1.2 1.2 0 0 1 0-1.7l.5-.5a1.2 1.2 0 0 1 1.7 0l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V5.5a1.2 1.2 0 0 1 1.2-1.2h.7a1.2 1.2 0 0 1 1.2 1.2v.2a1 1 0 0 0 .6.9 1 1 0 0 0 1.1-.2l.1-.1a1.2 1.2 0 0 1 1.7 0l.5.5a1.2 1.2 0 0 1 0 1.7l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6h.2a1.2 1.2 0 0 1 1.2 1.2v.7a1.2 1.2 0 0 1-1.2 1.2h-.2a1 1 0 0 0-.9.6Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "ai") return <svg viewBox="0 0 24 24" fill="none"><path d="M12 3.8c3.9 0 7 2.8 7 6.2 0 2-1.1 3.8-2.9 4.9v3.3a1 1 0 0 1-1.6.8l-2.1-1.6c-.2 0-.3 0-.4 0-3.9 0-7-2.8-7-6.2s3.1-6.2 7-6.2Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9" cy="10.1" r="1.1" fill="currentColor" /><circle cx="12" cy="10.1" r="1.1" fill="currentColor" /><circle cx="15" cy="10.1" r="1.1" fill="currentColor" /></svg>;
  if (name === "streak") return <svg viewBox="0 0 24 24" fill="none"><path d="M13.2 3.8c.3 2.5-.5 4-2.4 5.5-1.2 1-2.3 2.3-2.3 4.2 0 2.2 1.8 4 4 4 2.5 0 4.4-2 4.4-4.5 0-2.8-1.6-4.4-3.7-5.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.3 10.6c.2 1.4-.2 2.3-1.2 3-.6.5-1 1.1-1 2 0 1.1.9 2 2 2 1.2 0 2.1-.9 2.1-2.2 0-1.4-.8-2.3-1.9-2.8" fill="currentColor" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none"><path d="m12 4 1.9 3.8 4.1.6-3 2.9.7 4.1L12 13.4l-3.7 2 .7-4.1-3-2.9 4.1-.6L12 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
}
