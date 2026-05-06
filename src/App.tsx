import { AnimatePresence, motion } from "framer-motion";
import { differenceInCalendarDays, eachDayOfInterval, endOfMonth, format, formatDistanceToNow, getDay, isSameWeek, parseISO, startOfDay, startOfMonth } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { askGroqFinanceAssistant } from "./ai";
import { CATEGORY_NAMES, getCategoryDefinition } from "./categories";
import { askFinanceAssistant, forecast, getUpcomingBills, money } from "./logic";
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
  const [timelineEvents, setTimelineEvents] = useState<Array<{ id: number; title: string; hour: number; category: TimelineCategory }>>([]);
  const [timelineTitle, setTimelineTitle] = useState("");
  const [timelineHour, setTimelineHour] = useState("9");
  const [timelineCategory, setTimelineCategory] = useState<TimelineCategory>("work");
  const [mealName, setMealName] = useState("");
  const [meals, setMeals] = useState<Array<{ id: number; name: string; planned: boolean; done: boolean; calories: string }>>([
    { id: 1, name: "Breakfast", planned: false, done: false, calories: "" },
    { id: 2, name: "Lunch", planned: false, done: false, calories: "" },
    { id: 3, name: "Dinner", planned: false, done: false, calories: "" },
  ]);
  const [tasks, setTasks] = useState<Array<{ id: number; title: string; priority: TaskPriority; category: TimelineCategory; done: boolean }>>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPriority, setTaskPriority] = useState<TaskPriority>("medium");
  const [taskCategory, setTaskCategory] = useState<TimelineCategory>("work");
  const [taskFilter, setTaskFilter] = useState<"all" | "open" | "done">("all");
  const [taskCategoryFilter, setTaskCategoryFilter] = useState<"all" | TimelineCategory>("all");
  const [reflectionOne, setReflectionOne] = useState("");
  const [reflectionTwo, setReflectionTwo] = useState("");
  const [dayRating, setDayRating] = useState<1 | 2 | 3 | 4 | 5 | null>(null);
  const [dayClosed, setDayClosed] = useState(false);
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

  const weeklyTransactionsNet = useMemo(
    () =>
      transactions
        .filter((tx) => isSameWeek(parseISO(tx.date), new Date(), { weekStartsOn: 1 }))
        .reduce((acc, tx) => {
          const normalized = tx.type === "expense" ? -Math.abs(tx.amount) : Math.abs(tx.amount);
          return acc + normalized;
        }, 0),
    [transactions],
  );
  const weeklySpent = useMemo(
    () =>
      transactions
        .filter((tx) => isSameWeek(parseISO(tx.date), new Date(), { weekStartsOn: 1 }) && tx.type === "expense")
        .reduce((acc, tx) => acc + Math.abs(tx.amount), 0),
    [transactions],
  );
  const weeklyIncome = useMemo(
    () =>
      transactions
        .filter((tx) => isSameWeek(parseISO(tx.date), new Date(), { weekStartsOn: 1 }) && tx.type === "income")
        .reduce((acc, tx) => acc + Math.abs(tx.amount), 0),
    [transactions],
  );
  const weeklyUpcomingSubs = useMemo(
    () => getUpcomingBills(subscriptions, 7).reduce((acc, sub) => acc + sub.amount, 0),
    [subscriptions],
  );
  const monthlyTransactionsNet = useMemo(
    () =>
      transactions
        .filter((tx) => format(parseISO(tx.date), "yyyy-MM") === format(new Date(), "yyyy-MM"))
        .reduce((acc, tx) => {
          const normalized = tx.type === "expense" ? -Math.abs(tx.amount) : Math.abs(tx.amount);
          return acc + normalized;
        }, 0),
    [transactions],
  );
  const monthlyUpcomingSubs = useMemo(
    () => getUpcomingBills(subscriptions, 30).reduce((acc, sub) => acc + sub.amount, 0),
    [subscriptions],
  );
  const monthlySalary = settings?.monthlySalary ?? 0;
  const realBalance = settings?.currentBalance ?? 0;
  const weeklySalaryAllocation = monthlySalary / 4.33;
  const monthlySavingsReserve = settings?.reservedSavings ?? 0;
  const weeklySavingsReserve = monthlySavingsReserve / 4.33;
  const weeklyRealBalance = weeklySalaryAllocation + weeklyTransactionsNet - weeklyUpcomingSubs - weeklySavingsReserve;
  const monthlyRealBalance = realBalance + monthlyTransactionsNet - monthlyUpcomingSubs - monthlySavingsReserve;
  const daysLeftInMonth = Math.max(
    1,
    differenceInCalendarDays(endOfMonth(new Date()), startOfDay(new Date())) + 1,
  );
  const weeklySafeToUse = Math.max(0, (monthlyRealBalance / daysLeftInMonth) * 7);
  const daysLeftInWeek = Math.max(1, 7 - (new Date().getDay() === 0 ? 7 : new Date().getDay()) + 1);
  const weeklyAllowanceBase = Math.max(0, Math.min(weeklySafeToUse, weeklyRealBalance));
  const safePerDay = weeklyAllowanceBase / daysLeftInWeek;
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
    const selectedDayOfWeek = selected.getDay() === 0 ? 7 : selected.getDay();
    const daysLeftFromSelectedDay = Math.max(1, 7 - selectedDayOfWeek + 1);
    return weeklyAllowanceBase / daysLeftFromSelectedDay;
  }, [selectedCalendarDay, weeklyAllowanceBase]);
  const todayKey = format(new Date(), "yyyy-MM-dd");
  const todaySpent = dailyBreakdown[todayKey]?.spent || 0;
  const todayRemaining = safePerDay - todaySpent;
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
  const ritualCompletion = useMemo(
    () => ([
      ritualReview.trim().length > 0,
      [ritualPriorityOne, ritualPriorityTwo, ritualPriorityThree].filter((v) => v.trim().length > 0).length === 3,
      ritualIntention.trim().length > 0,
      ritualAvoid.trim().length > 0,
      ritualEnergy >= 1 && ritualEnergy <= 5,
    ]),
    [ritualReview, ritualPriorityOne, ritualPriorityTwo, ritualPriorityThree, ritualIntention, ritualAvoid, ritualEnergy],
  );
  const ritualDoneCount = useMemo(() => ritualCompletion.filter(Boolean).length, [ritualCompletion]);
  const ritualProgress = useMemo(
    () => (ritualDoneCount / ritualCompletion.length) * 100,
    [ritualDoneCount, ritualCompletion.length],
  );
  const sortedTimelineEvents = useMemo(() => {
    const copy = [...timelineEvents];
    copy.sort((a, b) => timelineSortAsc ? a.hour - b.hour : b.hour - a.hour);
    return copy;
  }, [timelineEvents, timelineSortAsc]);
  const timelineHours = useMemo(() => Array.from({ length: 17 }, (_, idx) => idx + 6), []);
  const mealStats = useMemo(() => {
    const planned = meals.filter((m) => m.planned).length;
    const completed = meals.filter((m) => m.done).length;
    const totalCalories = meals.reduce((acc, m) => acc + (Number(m.calories) || 0), 0);
    const completion = planned > 0 ? Math.round((completed / planned) * 100) : 0;
    return { planned, completed, totalCalories, completion };
  }, [meals]);
  const filteredTasks = useMemo(
    () => tasks.filter((t) => {
      if (taskFilter === "open" && t.done) return false;
      if (taskFilter === "done" && !t.done) return false;
      if (taskCategoryFilter !== "all" && t.category !== taskCategoryFilter) return false;
      return true;
    }),
    [tasks, taskFilter, taskCategoryFilter],
  );
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
      return;
    }
    const permission = await Notification.requestPermission();
    setNotifState(permission as "default" | "granted" | "denied");
    if (permission !== "granted") return;

    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: "UPDATE_NOTIFICATION_DATA", payload: { upcomingCount: upcoming.length } });
    await registration.showNotification("Zero notifications enabled", {
      body: "We will remind you about upcoming bills and daily money check-ins.",
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
  };

  const testNotification = async () => {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("Zero reminder", {
      body: `You have ${upcoming.length} upcoming bill(s). Open Zero for details.`,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "zero-test",
    });
  };

  const askAssistant = async (question: string) => {
    if (!question.trim() || !settings) return;
    const text = question.trim();
    const historyBeforeQuestion = [...chat] as Array<{ role: "assistant" | "user"; text: string }>;
    const nextHistory = [...historyBeforeQuestion, { role: "user", text }] as Array<{ role: "assistant" | "user"; text: string }>;
    setChat(nextHistory);
    setAssistantBusy(true);
    try {
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
      });
      setAssistantEngine("groq");
      setAssistantEngineReason("");
      setChat((c) => [...c, { role: "assistant", text: answer }]);
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
              <div className="row">
                <div>
                  <p className="home-kicker">Daily briefing</p>
                  <h2 className="home-title">Today at a glance</h2>
                </div>
                <span className="briefing-score">{overallScore}%</span>
              </div>
              <div className="briefing-grid">
                <article>
                  <p className="muted">Money</p>
                  <strong className={todayRemaining < 0 ? "negative" : "positive"}>{dailyBriefing.moneySignal}</strong>
                </article>
                <article>
                  <p className="muted">Meals</p>
                  <strong>{dailyBriefing.mealSignal}</strong>
                </article>
                <article>
                  <p className="muted">Tasks</p>
                  <strong>{dailyBriefing.taskSignal}</strong>
                </article>
                <article>
                  <p className="muted">Next 3d bills</p>
                  <strong>{dailyBriefing.nextBills}</strong>
                </article>
              </div>
              <p className="muted">
                {dailyBriefing.openTasks > 0
                  ? `${dailyBriefing.openTasks} open task(s) left. Prioritize top 1 before evening.`
                  : "You are clear on tasks. Protect your spending pace and close strong."}
              </p>
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
              <div className="row">
                <h3>Daily allowance goal</h3>
                <span className="goal-pill">{money(safePerDay)}</span>
              </div>
              <p className="muted">Based on your current balance and weekly safe-to-use.</p>
              <div className="daily-goal-ring-wrap">
                <div
                  className="daily-goal-ring"
                  style={{
                    background: `conic-gradient(#0a84ff ${Math.min(
                      100,
                      Math.max(0, (Math.abs(weeklySpent - weeklyIncome) / Math.max(1, safePerDay * 7)) * 100),
                    )}%, #e6ebf5 0%)`,
                  }}
                >
                  <div className="daily-goal-inner">
                    <p className="muted">Today target</p>
                    <strong>{money(safePerDay)}</strong>
                  </div>
                </div>
              </div>
              <div className="snapshot-grid">
                <article><p className="muted">Spent today</p><strong>{money(todaySpent)}</strong></article>
                <article><p className="muted">Left for today</p><strong className={todayRemaining < 0 ? "negative" : "positive"}>{money(todayRemaining)}</strong></article>
                <article><p className="muted">Bills due this week</p><strong>{money(weeklyUpcomingSubs)}</strong></article>
              </div>
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
                {spendingCalendar.map((cell) =>
                  cell.blank ? (
                    <div key={cell.key} className="calendar-cell blank" />
                  ) : (
                    <button
                      key={cell.key}
                      type="button"
                      className={`calendar-cell ${cell.today ? "today" : ""} ${selectedCalendarDay === cell.key ? "selected" : ""}`}
                      onClick={() => {
                        setSelectedCalendarDay(cell.key);
                        setShowCalendarDaySheet(true);
                      }}
                    >
                      <span className="day">{cell.day}</span>
                      <span className={`amt ${cell.amount > 0 ? "spent" : ""}`}>
                        {cell.amount > 0 ? money(cell.amount) : "-"}
                      </span>
                    </button>
                  ),
                )}
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
            <section className="card routine-card routine-card-equal">
              <div className="row">
                <h3>Morning ritual</h3>
                <span className="badge">{ritualDoneCount}/5 done</span>
              </div>
              <p className="muted">5-step guided planning session.</p>
              <div className="routine-progress-track"><div className="routine-progress-fill" style={{ width: `${ritualProgress}%` }} /></div>
              <label className="routine-step-label">
                <span className="routine-step-title">1. Review yesterday</span>
                <textarea value={ritualReview} onChange={(e) => setRitualReview(e.target.value)} rows={2} placeholder="What worked well yesterday?" />
              </label>
              <div className="routine-step-label">
                <span className="routine-step-title">2. Set top 3 priorities</span>
                <div className="routine-priority-grid">
                  <input value={ritualPriorityOne} onChange={(e) => setRitualPriorityOne(e.target.value)} placeholder="Priority 1" />
                  <input value={ritualPriorityTwo} onChange={(e) => setRitualPriorityTwo(e.target.value)} placeholder="Priority 2" />
                  <input value={ritualPriorityThree} onChange={(e) => setRitualPriorityThree(e.target.value)} placeholder="Priority 3" />
                </div>
              </div>
              <label className="routine-step-label">
                <span className="routine-step-title">3. Write daily intention</span>
                <input value={ritualIntention} onChange={(e) => setRitualIntention(e.target.value)} placeholder="How do you want to show up today?" />
              </label>
              <label className="routine-step-label">
                <span className="routine-step-title">4. List things to avoid</span>
                <input value={ritualAvoid} onChange={(e) => setRitualAvoid(e.target.value)} placeholder="Distractions or habits to avoid" />
              </label>
              <label className="routine-step-label">
                <span className="routine-step-title">5. Rate energy level ({ritualEnergy}/5)</span>
                <input type="range" min={1} max={5} step={1} value={ritualEnergy} onChange={(e) => setRitualEnergy(Number(e.target.value))} />
              </label>
              <div className="routine-checkline">
                {["Review", "Top 3", "Intention", "Avoid", "Energy"].map((name, idx) => (
                  <span key={name} className={`routine-check-pill ${ritualCompletion[idx] ? "done" : ""}`}>{name}</span>
                ))}
              </div>
            </section>

            <section className="card routine-card routine-card-equal">
              <div className="row">
                <h3>Visual day timeline</h3>
                <button type="button" className="ghost-btn" onClick={() => setTimelineSortAsc((v) => !v)}>
                  Sort: {timelineSortAsc ? "earliest" : "latest"}
                </button>
              </div>
              <p className="muted">6am to 10pm flow with live current-hour indicator.</p>
              <div className="timeline-add-form">
                <input value={timelineTitle} onChange={(e) => setTimelineTitle(e.target.value)} placeholder="Add event" />
                <input type="number" min={6} max={22} value={timelineHour} onChange={(e) => setTimelineHour(e.target.value)} />
                <select value={timelineCategory} onChange={(e) => setTimelineCategory(e.target.value as TimelineCategory)}>
                  <option value="work">Work</option>
                  <option value="health">Health</option>
                  <option value="personal">Personal</option>
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const hour = Number(timelineHour);
                    if (!timelineTitle.trim() || hour < 6 || hour > 22) return;
                    setTimelineEvents((prev) => [...prev, { id: Date.now(), title: timelineTitle.trim(), hour, category: timelineCategory }]);
                    setTimelineTitle("");
                  }}
                >
                  Add
                </button>
              </div>
              <div className="timeline-list">
                {timelineHours.map((hour) => {
                  const atHour = sortedTimelineEvents.filter((event) => event.hour === hour);
                  return (
                    <div key={hour} className={`timeline-hour ${hour === currentHour ? "current" : ""}`}>
                      <div className="timeline-hour-label">
                        {hour === 12 ? "12pm" : hour > 12 ? `${hour - 12}pm` : `${hour}am`}
                        {hour === currentHour && <span className="timeline-now">You are here</span>}
                      </div>
                      <div className="timeline-hour-events">
                        {atHour.length === 0 && <p className="muted">-</p>}
                        {atHour.map((event) => (
                          <div key={event.id} className={`timeline-event ${event.category}`}>
                            <span>{event.title}</span>
                            <button type="button" onClick={() => setTimelineEvents((prev) => prev.filter((x) => x.id !== event.id))}>Delete</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              {timelineEvents.length === 0 && <p className="muted routine-empty">No events yet. Add your first block to map your day.</p>}
            </section>

            <section className="card routine-card">
              <div className="row">
                <h3>Meal planner</h3>
                <span className="badge">{mealStats.completion}%</span>
              </div>
              <p className="muted">Plan meals, mark completed, and track calories for the day.</p>
              <div className="meal-add-row">
                <input value={mealName} onChange={(e) => setMealName(e.target.value)} placeholder="Add meal (e.g. Snack)" />
                <button
                  type="button"
                  onClick={() => {
                    if (!mealName.trim()) return;
                    setMeals((prev) => [...prev, { id: Date.now(), name: mealName.trim(), planned: true, done: false, calories: "" }]);
                    setMealName("");
                  }}
                >
                  Add
                </button>
              </div>
              <div className="meal-grid">
                {meals.map((meal) => (
                  <article key={meal.id} className="meal-item">
                    <div className="meal-head">
                      <strong>{meal.name}</strong>
                      <button type="button" className="ghost-btn" onClick={() => setMeals((prev) => prev.filter((m) => m.id !== meal.id))}>Delete</button>
                    </div>
                    <div className="meal-toggle-row">
                      <label className="routine-check-item">
                        <input type="checkbox" checked={meal.planned} onChange={() => setMeals((prev) => prev.map((m) => m.id === meal.id ? { ...m, planned: !m.planned } : m))} />
                        <span>Planned</span>
                      </label>
                      <label className="routine-check-item">
                        <input type="checkbox" checked={meal.done} onChange={() => setMeals((prev) => prev.map((m) => m.id === meal.id ? { ...m, done: !m.done } : m))} />
                        <span>Done</span>
                      </label>
                    </div>
                    <div className="meal-calorie-row">
                      <input
                        type="number"
                        min={0}
                        value={meal.calories}
                        onChange={(e) => setMeals((prev) => prev.map((m) => m.id === meal.id ? { ...m, calories: e.target.value } : m))}
                        placeholder="Calories"
                      />
                    </div>
                  </article>
                ))}
              </div>
              <p className="muted">Planned: {mealStats.planned} · Done: {mealStats.completed} · Calories: {mealStats.totalCalories}</p>
              <div className="routine-progress-track"><div className="routine-progress-fill" style={{ width: `${mealStats.completion}%` }} /></div>
            </section>

            <section className="card routine-card">
              <div className="row">
                <h3>Task manager</h3>
                <span className="badge">{doneTasks}/{tasks.length} done</span>
              </div>
              <div className="routine-inline-form">
                <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Add task" />
                <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as TaskPriority)}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <select value={taskCategory} onChange={(e) => setTaskCategory(e.target.value as TimelineCategory)}>
                  <option value="work">Work</option>
                  <option value="personal">Personal</option>
                  <option value="health">Health</option>
                </select>
                <button type="button" onClick={() => {
                  if (!taskTitle.trim()) return;
                  setTasks((prev) => [...prev, { id: Date.now(), title: taskTitle.trim(), priority: taskPriority, category: taskCategory, done: false }]);
                  setTaskTitle("");
                }}>Add</button>
              </div>
              <div className="task-filter-row">
                <button type="button" className={taskFilter === "all" ? "active" : ""} onClick={() => setTaskFilter("all")}>All</button>
                <button type="button" className={taskFilter === "open" ? "active" : ""} onClick={() => setTaskFilter("open")}>Open</button>
                <button type="button" className={taskFilter === "done" ? "active" : ""} onClick={() => setTaskFilter("done")}>Done</button>
                <button type="button" className={taskCategoryFilter === "all" ? "active" : ""} onClick={() => setTaskCategoryFilter("all")}>Any tag</button>
                <button type="button" className={taskCategoryFilter === "work" ? "active" : ""} onClick={() => setTaskCategoryFilter("work")}>Work</button>
                <button type="button" className={taskCategoryFilter === "personal" ? "active" : ""} onClick={() => setTaskCategoryFilter("personal")}>Personal</button>
                <button type="button" className={taskCategoryFilter === "health" ? "active" : ""} onClick={() => setTaskCategoryFilter("health")}>Health</button>
              </div>
              {tasks.length === 0 && <p className="muted routine-empty">No tasks yet. Add tasks and organize your day by priority and tag.</p>}
              {filteredTasks.map((task) => (
                <div key={task.id} className="routine-row">
                  <label className="routine-check-item">
                    <input type="checkbox" checked={task.done} onChange={() => setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, done: !t.done } : t))} />
                    <span>{task.title}</span>
                  </label>
                  <span className={`task-meta ${task.priority}`}>{task.priority} · {task.category}</span>
                  <button type="button" className="ghost-btn" onClick={() => setTasks((prev) => prev.filter((t) => t.id !== task.id))}>Delete</button>
                </div>
              ))}
            </section>

            <section className="card routine-card">
              <div className="row">
                <h3>End-of-day shutdown</h3>
                <span className="badge">Score {overallScore}%</span>
              </div>
              <p className="muted">Tasks done: {doneTasks}/{tasks.length} · Meal plan: {mealStats.completion}%</p>
              <div className="routine-progress-track"><div className="routine-progress-fill" style={{ width: `${overallScore}%` }} /></div>
              <h4>Incomplete tasks</h4>
              {tasks.filter((t) => !t.done).length === 0 && <p className="muted">All tasks completed today.</p>}
              {tasks.filter((t) => !t.done).map((task) => (
                <div key={task.id} className="routine-row">
                  <span>{task.title}</span>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, done: false, title: `${t.title} (tomorrow)` } : t))}
                  >
                    Move to tomorrow
                  </button>
                </div>
              ))}
              <label>Reflection prompt 1: What went well today?
                <textarea value={reflectionOne} onChange={(e) => setReflectionOne(e.target.value)} rows={2} />
              </label>
              <label>Reflection prompt 2: What will I improve tomorrow?
                <textarea value={reflectionTwo} onChange={(e) => setReflectionTwo(e.target.value)} rows={2} />
              </label>
              <div className="day-rating-row">
                {[1, 2, 3, 4, 5].map((rate) => (
                  <button key={rate} type="button" className={dayRating === rate ? "active" : ""} onClick={() => setDayRating(rate as 1 | 2 | 3 | 4 | 5)}>
                    {rate}
                  </button>
                ))}
              </div>
              <button type="button" className="close-day-btn" onClick={() => setDayClosed(true)}>
                Close the day
              </button>
              {dayClosed && (
                <div className="routine-celebration">
                  <h4>Day closed. Great work.</h4>
                  <p className="muted">You stayed intentional today. Keep the streak alive tomorrow.</p>
                </div>
              )}
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
                <p className="muted">Weekly safe: {money(weeklySalaryAllocation)} + {money(weeklyTransactionsNet)} - {money(weeklyUpcomingSubs)} - {money(weeklySavingsReserve)}</p>
                <p className="muted">Monthly balance: {money(realBalance)} + {money(monthlyTransactionsNet)} - {money(monthlyUpcomingSubs)} - {money(monthlySavingsReserve)}</p>
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
              </div>
              <p className="muted">Status: <strong>{notifState}</strong></p>
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
