import { AnimatePresence, motion } from "framer-motion";
import { differenceInCalendarDays, eachDayOfInterval, endOfMonth, format, formatDistanceToNow, getDay, parseISO, startOfDay, startOfMonth, subDays } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { askGroqFinanceAssistant } from "./ai";
import { executeAssistantPayload, sanitizeActionsMarkerBody, streamedVisibleReply, stripActionMarkers } from "./assistantActions";
import { buildCashflowForecast } from "./cashflow";
import { CATEGORY_NAMES, getCategoryDefinition } from "./categories";
import { buildCoachMemories } from "./coachMemory";
import { db } from "./db";
import {
  assessAffordability,
  askFinanceAssistant,
  buildMoneyMetricExplanations,
  buildSavingsGoalPlanner,
  computeBudgetSnapshot,
  countOverBudgetDaysInMonth,
  countSubscriptionsDueThisWeek,
  getUpcomingBills,
  matchMoneyExplanationQuestion,
  money,
  nextDateFromCycle,
  simulateWhatIfScenario,
  type MoneyMetricExplanation,
  type MoneyMetricExplanationId,
} from "./logic";
import { fetchHargeisaWeather, type HargeisaWeatherBrief } from "./hargeisaWeather";
import { fetchSomalilandNews, type NewsItem } from "./news";
import { dedupeNormalizedTransactions, getTransactionQualitySnapshot, normalizeTransactionInput } from "./quality";
import { BiometricLockScreen } from "./BiometricLockScreen";
import { IosDayTimeline } from "./IosDayTimeline";
import { detectSubscriptionCandidates } from "./subscriptionDetection";
import { useZeroStore } from "./store";
import { clearBadge, updateBadge } from "./utils/badge";
import {
  bioLockClear,
  bioLockIsSupported,
  bioLockPlatformAuthenticatorAvailable,
  bioLockReadCredentialIdB64,
  bioLockReadEnabled,
  bioLockRegister,
} from "./webauthnLock";
import { PUSH_NOTIFICATION_KIND_META } from "./pushNotificationCopy";
import type {
  PlannedCashflowItem,
  PlannedCashflowKind,
  PushNotificationKind,
  RecurringIncome,
  RecurringIncomeCycle,
  Subscription,
  SubscriptionCycle,
  TxType,
} from "./types";

/** Background refresh while the app is open (Open-Meteo updates on model cadence; this keeps UI current). */
const WEATHER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/** When returning to the tab/window, refresh if last sync is older than this. */
const WEATHER_STALE_AFTER_MS = 5 * 60 * 1000;

const tabs = ["Home", "Transactions", "Subscriptions", "Insights", "Settings"] as const;
type Tab = (typeof tabs)[number];
const tabMeta: Record<Tab, { icon: "home" | "activity" | "subscriptions" | "insights" | "settings"; label: string }> = {
  Home: { icon: "home", label: "Home" },
  Transactions: { icon: "activity", label: "Activity" },
  Subscriptions: { icon: "subscriptions", label: "Subs" },
  Insights: { icon: "insights", label: "Routine" },
  Settings: { icon: "settings", label: "Settings" },
};
type TimelineCategory = "work" | "health" | "personal";
type TaskPriority = "high" | "medium" | "low";
type ThemePreference = "system" | "light" | "dark";
const STREAK_DAY_SURFACES: Array<Pick<CSSProperties, "background" | "boxShadow">> = [
  {
    background: "linear-gradient(145deg, #ff7a7a, #ef4444)",
    boxShadow: "0 8px 18px rgba(239, 68, 68, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
  {
    background: "linear-gradient(145deg, #fb923c, #f97316)",
    boxShadow: "0 8px 18px rgba(249, 115, 22, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
  {
    background: "linear-gradient(145deg, #facc15, #eab308)",
    boxShadow: "0 8px 18px rgba(234, 179, 8, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
  {
    background: "linear-gradient(145deg, #4ade80, #22c55e)",
    boxShadow: "0 8px 18px rgba(34, 197, 94, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
  {
    background: "linear-gradient(145deg, #2dd4bf, #14b8a6)",
    boxShadow: "0 8px 18px rgba(20, 184, 166, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
  {
    background: "linear-gradient(145deg, #60a5fa, #3b82f6)",
    boxShadow: "0 8px 18px rgba(59, 130, 246, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
  {
    background: "linear-gradient(145deg, #a78bfa, #8b5cf6)",
    boxShadow: "0 8px 18px rgba(139, 92, 246, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
  {
    background: "linear-gradient(145deg, #f472b6, #ec4899)",
    boxShadow: "0 8px 18px rgba(236, 72, 153, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.52)",
  },
];

type TimelineEvent = {
  id: number;
  title: string;
  hour: number;
  startMinute?: number;
  category: TimelineCategory;
  durationMinutes?: number;
  subtasks?: string[];
  /** yyyy-MM-dd; omit only for legacy rows—treated as “today” when matching the current calendar day. */
  date?: string;
};

function timelineStartMinutes(e: Pick<TimelineEvent, "hour" | "startMinute">) {
  return e.hour * 60 + (e.startMinute ?? 0);
}

function formatTimelineClock(e: Pick<TimelineEvent, "hour" | "startMinute">) {
  const d = new Date();
  const m = timelineStartMinutes(e);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return format(d, "h:mm a");
}
type RoutineTemplateBlock = { id: number; name: string; hour: number; durationMinutes: number; category: TimelineCategory };
type PlanAheadItem = { id?: number; date: string; title: string; hour: number; category: TimelineCategory; createdAt: string };
type RoutineReminderItem = {
  id: number;
  label: string;
  message: string;
  mode: "in" | "clock";
  delaySeconds: number;
  clockTime?: string;
  enabled: boolean;
};
type RoutineDaySnapshot = {
  timelineEvents: TimelineEvent[];
  tasks: Array<{ id: number; title: string; priority: TaskPriority; category: TimelineCategory; done: boolean }>;
  meals: Array<{ id: number; name: string; group?: MealGroup; planned?: boolean; done: boolean; calories: string }>;
  ritualEnergy: number;
  dayRating: 1 | 2 | 3 | 4 | 5 | null;
};
type MealGroup = "Breakfast" | "Lunch" | "Dinner" | "Snacks";
type WhatIfScenarioRecord = {
  id: number;
  prompt: string;
  title: string;
  changes: string[];
  currentMonthEnd: number;
  simulatedMonthEnd: number;
  totalSavings: number;
  createdAt: string;
};
type RecurringIncomeDraft = {
  id: number | null;
  name: string;
  amount: string;
  cycle: RecurringIncomeCycle;
  nextDate: string;
};
type PlannedCashflowDraft = {
  id: number | null;
  title: string;
  amount: string;
  kind: PlannedCashflowKind;
  date: string;
  category: string;
};
type DailyContextNoteDraft = {
  title: string;
  body: string;
  tags: string;
  aiVisible: boolean;
};

function todayInputValue() {
  return format(new Date(), "yyyy-MM-dd");
}

function createEmptyRecurringIncomeDraft(): RecurringIncomeDraft {
  return {
    id: null,
    name: "",
    amount: "",
    cycle: "monthly",
    nextDate: todayInputValue(),
  };
}

function createEmptyPlannedCashflowDraft(): PlannedCashflowDraft {
  return {
    id: null,
    title: "",
    amount: "",
    kind: "planned_expense",
    date: todayInputValue(),
    category: "",
  };
}

function createEmptyDailyContextNoteDraft(): DailyContextNoteDraft {
  return {
    title: "",
    body: "",
    tags: "",
    aiVisible: true,
  };
}

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
  const {
    loading,
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    savingsGoals,
    coachMemories,
    dailyContextNotes,
    settings,
    init,
    addTransaction,
    deleteTransaction,
    updateTransaction,
    addSubscription,
    updateSubscription,
    addRecurringIncome,
    updateRecurringIncome,
    deleteRecurringIncome,
    addPlannedCashflow,
    updatePlannedCashflow,
    deletePlannedCashflow,
    addSavingsGoal,
    addTransactionsBulk,
    updateSettings,
    replaceCoachMemories,
    upsertDailyContextNote,
    deleteDailyContextNote,
    clearData,
    recategorizeTransactions,
  } = useZeroStore();
  const [tab, setTab] = useState<Tab>("Home");
  const [showTx, setShowTx] = useState(false);
  const [showSub, setShowSub] = useState(false);
  const [showBulkTx, setShowBulkTx] = useState(false);
  const [showWeeklySafe, setShowWeeklySafe] = useState(false);
  const [showMonthlyBalance, setShowMonthlyBalance] = useState(false);
  const [editingMonthlyReal, setEditingMonthlyReal] = useState(false);
  const [monthlyRealDraft, setMonthlyRealDraft] = useState("");
  const [showAllowancePlanDetails, setShowAllowancePlanDetails] = useState(false);
  const [showAllowanceBillsDetails, setShowAllowanceBillsDetails] = useState(false);
  const [savingPulseDone, setSavingPulseDone] = useState(false);
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState("");
  const [weatherBrief, setWeatherBrief] = useState<HargeisaWeatherBrief | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(true);
  const [weatherError, setWeatherError] = useState("");
  const weatherBriefRef = useRef<HargeisaWeatherBrief | null>(null);
  const weatherFetchAbortRef = useRef<AbortController | null>(null);
  const [regionalBriefExpanded, setRegionalBriefExpanded] = useState(() => {
    try {
      const s = localStorage.getItem("zero_regional_brief_expanded_v2");
      return s === "1";
    } catch {
      // ignore
    }
    return false;
  });
  const [cashflowOutlookExpanded, setCashflowOutlookExpanded] = useState(false);
  const [todayNoteExpanded, setTodayNoteExpanded] = useState(() => {
    try {
      const s = localStorage.getItem("zero_today_note_expanded_v1");
      return s !== "0";
    } catch {
      // ignore
    }
    return true;
  });
  const [activeMoneyExplanation, setActiveMoneyExplanation] = useState<MoneyMetricExplanationId | null>(null);
  const [editingTx, setEditingTx] = useState<any | null>(null);
  const [editingSub, setEditingSub] = useState<Subscription | null>(null);
  const [markPaidTarget, setMarkPaidTarget] = useState<Subscription | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQuestion, setAssistantQuestion] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantEngine, setAssistantEngine] = useState<"groq" | "fallback">("fallback");
  const [assistantEngineReason, setAssistantEngineReason] = useState("");
  const [groqBackendLive, setGroqBackendLive] = useState(false);
  const [showWhatIfBuilder, setShowWhatIfBuilder] = useState(false);
  const [whatIfCutCategory, setWhatIfCutCategory] = useState("food");
  const [whatIfCutPercent, setWhatIfCutPercent] = useState(15);
  const [whatIfCancelSubscriptionId, setWhatIfCancelSubscriptionId] = useState<number | null>(null);
  const [whatIfScenarios, setWhatIfScenarios] = useState<WhatIfScenarioRecord[]>(() => {
    try {
      const raw = localStorage.getItem("zero_what_if_scenarios_v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as WhatIfScenarioRecord[];
      return Array.isArray(parsed) ? parsed.slice(0, 12) : [];
    } catch {
      return [];
    }
  });
  const [incomeDraft, setIncomeDraft] = useState<RecurringIncomeDraft>(() => createEmptyRecurringIncomeDraft());
  const [incomeDraftError, setIncomeDraftError] = useState("");
  const [plannedCashflowDraft, setPlannedCashflowDraft] = useState<PlannedCashflowDraft>(() => createEmptyPlannedCashflowDraft());
  const [plannedCashflowDraftError, setPlannedCashflowDraftError] = useState("");
  const [dailyContextNoteDraft, setDailyContextNoteDraft] = useState<DailyContextNoteDraft>(() => createEmptyDailyContextNoteDraft());
  const [dailyContextNoteStatus, setDailyContextNoteStatus] = useState("");
  const [dismissedSubscriptionSuggestions, setDismissedSubscriptionSuggestions] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("zero_subscription_detection_dismissed_v1");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 200) : [];
    } catch {
      return [];
    }
  });
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
  const [showReminderSheet, setShowReminderSheet] = useState(false);
  const [meals, setMeals] = useState<Array<{ id: number; name: string; group?: MealGroup; planned?: boolean; done: boolean; calories: string }>>([]);
  const [tasks, setTasks] = useState<Array<{ id: number; title: string; priority: TaskPriority; category: TimelineCategory; done: boolean }>>([]);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [checklistDraft, setChecklistDraft] = useState<{
    title: string;
    priority: TaskPriority;
    category: TimelineCategory;
  }>({ title: "", priority: "medium", category: "personal" });
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
  const [routineHistory, setRoutineHistory] = useState<Record<string, RoutineDaySnapshot>>({});
  const [currentHour, setCurrentHour] = useState(new Date().getHours());
  const [liveNow, setLiveNow] = useState(new Date());
  const [selectedCalendarDay, setSelectedCalendarDay] = useState<string>(format(new Date(), "yyyy-MM-dd"));
  const [showCalendarDaySheet, setShowCalendarDaySheet] = useState(false);
  const [chat, setChat] = useState<Array<{ role: "assistant" | "user"; text: string }>>(() => {
    try {
      const raw = localStorage.getItem("zero_ai_chat_v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Array<{ role: "assistant" | "user"; text: string }>;
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      return [];
    }
  });
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  /** Tracks calendar day for checklist rollover (completed tasks drop after midnight). */
  const routineCalendarDayRef = useRef<string | null>(null);
  const [notifState, setNotifState] = useState<"unsupported" | "default" | "granted" | "denied">(
    "default",
  );
  const [pushConnected, setPushConnected] = useState(false);
  const [streakProtectionEnabled, setStreakProtectionEnabled] = useState(() => {
    try {
      if (localStorage.getItem("zero_streak_protection_v1") === "0") return false;
    } catch {
      // ignore
    }
    return true;
  });
  const [pushStatusDetail, setPushStatusDetail] = useState("");
  const [testNotifDelaySec, setTestNotifDelaySec] = useState("10");
  const [scheduledNotifAt, setScheduledNotifAt] = useState<number | null>(null);
  const [timerNow, setTimerNow] = useState<number>(Date.now());
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    try {
      const saved = localStorage.getItem("zero_theme_preference_v1");
      if (saved === "light" || saved === "dark" || saved === "system") return saved;
    } catch {
      // ignore local storage issues
    }
    return "system";
  });
  const [bioLockCredentialPresent, setBioLockCredentialPresent] = useState(() => bioLockReadCredentialIdB64() != null);
  const [bioLockFeatureEnabled, setBioLockFeatureEnabled] = useState(() => bioLockReadEnabled());
  const bioLockNeedsChallenge = bioLockFeatureEnabled && bioLockCredentialPresent;
  const [bioLockUnlocked, setBioLockUnlocked] = useState(
    () => !(bioLockReadEnabled() && bioLockReadCredentialIdB64() != null),
  );
  const [bioLockUiHint, setBioLockUiHint] = useState("");
  const [bioLockPlatformReady, setBioLockPlatformReady] = useState(false);

  const syncAppBadge = useCallback(() => {
    const { transactions: tx, subscriptions: subs, settings: set } = useZeroStore.getState();
    if (!set) return;
    const taskList = tasksRef.current;
    const bills = countSubscriptionsDueThisWeek(subs);
    const highOpen = taskList.filter((t) => !t.done && t.priority === "high").length;
    const overDays = countOverBudgetDaysInMonth(tx, subs, set);
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      clearBadge();
      return;
    }
    updateBadge(bills, highOpen, overDays);
  }, []);

  useEffect(() => {
    clearBadge();
  }, []);

  useEffect(() => {
    const onFocusOrVisible = () => {
      if (document.visibilityState === "visible") clearBadge();
    };
    document.addEventListener("visibilitychange", onFocusOrVisible);
    window.addEventListener("focus", onFocusOrVisible);
    return () => {
      document.removeEventListener("visibilitychange", onFocusOrVisible);
      window.removeEventListener("focus", onFocusOrVisible);
    };
  }, []);

  useEffect(() => {
    syncAppBadge();
    return useZeroStore.subscribe(syncAppBadge);
  }, [syncAppBadge]);

  useEffect(() => {
    syncAppBadge();
  }, [tasks, syncAppBadge]);

  useEffect(() => {
    void bioLockPlatformAuthenticatorAvailable().then(setBioLockPlatformReady);
  }, []);

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = new Date();
      setCurrentHour(now.getHours());
      setLiveNow(now);
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void fetch("/api/groq/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { configured?: boolean; ok?: boolean } | null) => {
        setGroqBackendLive(Boolean(j?.configured ?? j?.ok));
      })
      .catch(() => setGroqBackendLive(false));
  }, []);

  useEffect(() => {
    if (!assistantOpen) return;
    void fetch("/api/groq/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { configured?: boolean; ok?: boolean } | null) => {
        setGroqBackendLive(Boolean(j?.configured ?? j?.ok));
      })
      .catch(() => setGroqBackendLive(false));
  }, [assistantOpen]);

  useEffect(() => {
    if (!routineHydrated) return;
    const key = format(liveNow, "yyyy-MM-dd");
    if (routineCalendarDayRef.current === null) {
      routineCalendarDayRef.current = key;
      return;
    }
    if (routineCalendarDayRef.current !== key) {
      routineCalendarDayRef.current = key;
      try {
        localStorage.setItem("zero_routine_tasks_day_v1", key);
      } catch {
        // ignore
      }
      setTasks((prev) => prev.filter((t) => !t.done));
    }
  }, [routineHydrated, liveNow]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("zero_routine_v1");
      if (!raw) {
        try {
          localStorage.setItem("zero_routine_tasks_day_v1", format(new Date(), "yyyy-MM-dd"));
        } catch {
          // ignore
        }
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
      if (Array.isArray(parsed.tasks)) {
        const todayKey = format(new Date(), "yyyy-MM-dd");
        let lastTasksDay = "";
        try {
          lastTasksDay = localStorage.getItem("zero_routine_tasks_day_v1") ?? "";
        } catch {
          // ignore
        }
        if (lastTasksDay !== "" && lastTasksDay !== todayKey) {
          setTasks(parsed.tasks.filter((t) => !t.done));
        } else {
          setTasks(parsed.tasks);
        }
        try {
          localStorage.setItem("zero_routine_tasks_day_v1", todayKey);
        } catch {
          // ignore
        }
      } else {
        const todayKey = format(new Date(), "yyyy-MM-dd");
        let lastTasksDay = "";
        try {
          lastTasksDay = localStorage.getItem("zero_routine_tasks_day_v1") ?? "";
        } catch {
          // ignore
        }
        try {
          localStorage.setItem("zero_routine_tasks_day_v1", todayKey);
        } catch {
          // ignore
        }
        if (lastTasksDay !== "" && lastTasksDay !== todayKey) {
          setTasks([]);
        }
      }
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
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = themePreference === "system"
        ? (media.matches ? "dark" : "light")
        : themePreference;
      document.documentElement.setAttribute("data-theme", resolved);
    };
    applyTheme();
    localStorage.setItem("zero_theme_preference_v1", themePreference);
    if (themePreference !== "system") return;
    const onChange = () => applyTheme();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themePreference]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "zero_regional_brief_expanded_v2",
        regionalBriefExpanded ? "1" : "0",
      );
    } catch {
      // ignore
    }
  }, [regionalBriefExpanded]);
  useEffect(() => {
    try {
      localStorage.setItem("zero_streak_protection_v1", streakProtectionEnabled ? "1" : "0");
    } catch {
      // ignore
    }
  }, [streakProtectionEnabled]);
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
    localStorage.setItem("zero_what_if_scenarios_v1", JSON.stringify(whatIfScenarios.slice(0, 12)));
  }, [whatIfScenarios]);
  useEffect(() => {
    localStorage.setItem(
      "zero_subscription_detection_dismissed_v1",
      JSON.stringify(dismissedSubscriptionSuggestions.slice(0, 200)),
    );
  }, [dismissedSubscriptionSuggestions]);
  useEffect(() => {
    try {
      localStorage.setItem("zero_today_note_expanded_v1", todayNoteExpanded ? "1" : "0");
    } catch {
      // ignore
    }
  }, [todayNoteExpanded]);

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
    weatherBriefRef.current = weatherBrief;
  }, [weatherBrief]);

  const refreshWeather = useCallback(async (opts?: { background?: boolean; signal?: AbortSignal }) => {
    const inherited = opts?.signal;
    const hadData = weatherBriefRef.current != null;
    const background = Boolean(opts?.background && hadData);

    let signal: AbortSignal;
    if (inherited) {
      signal = inherited;
    } else {
      weatherFetchAbortRef.current?.abort();
      const controller = new AbortController();
      weatherFetchAbortRef.current = controller;
      signal = controller.signal;
    }

    if (!background) {
      setWeatherLoading(true);
      setWeatherError("");
    }

    try {
      const w = await fetchHargeisaWeather(signal);
      if (signal.aborted) return;

      if (w) {
        setWeatherBrief(w);
        if (!background) setWeatherError("");
      } else if (!background) {
        setWeatherBrief(null);
        setWeatherError("Forecast unavailable.");
      }
    } catch {
      if (signal.aborted) return;
      if (!background) {
        setWeatherBrief(null);
        setWeatherError("Forecast unavailable.");
      }
    } finally {
      if (!background) setWeatherLoading(false);
    }
  }, []);

  const refreshRegionalBrief = useCallback(async () => {
    weatherFetchAbortRef.current?.abort();
    const controller = new AbortController();
    weatherFetchAbortRef.current = controller;

    setNewsLoading(true);
    setWeatherLoading(true);
    setNewsError("");
    setWeatherError("");

    await Promise.all([
      fetchSomalilandNews(controller.signal)
        .then((items) => {
          setNewsItems(items);
          if (items.length === 0) setNewsError("No recent Somaliland posts found right now.");
        })
        .catch(() => {
          setNewsItems([]);
          setNewsError(
            import.meta.env.DEV
              ? "Somaliland X updates need the API server. Run npm run start (port 3000) while vite dev runs."
              : "Couldn't load Somaliland updates.",
          );
        })
        .finally(() => setNewsLoading(false)),
      refreshWeather({ signal: controller.signal }),
    ]);
  }, [refreshWeather]);

  useEffect(() => {
    void refreshRegionalBrief();
  }, [refreshRegionalBrief]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshWeather({ background: true });
    }, WEATHER_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refreshWeather]);

  useEffect(() => {
    const maybeRefreshWeather = () => {
      if (document.visibilityState !== "visible") return;
      const brief = weatherBriefRef.current;
      if (!brief) return;
      const fetchedMs = Date.parse(brief.fetchedAt);
      if (!Number.isFinite(fetchedMs)) return;
      if (Date.now() - fetchedMs <= WEATHER_STALE_AFTER_MS) return;
      void refreshWeather({ background: true });
    };
    document.addEventListener("visibilitychange", maybeRefreshWeather);
    window.addEventListener("focus", maybeRefreshWeather);
    return () => {
      document.removeEventListener("visibilitychange", maybeRefreshWeather);
      window.removeEventListener("focus", maybeRefreshWeather);
    };
  }, [refreshWeather]);

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
  const cashflowForecast = useMemo(
    () => (
      settings
        ? buildCashflowForecast({
          transactions,
          subscriptions,
          recurringIncome,
          plannedCashflows,
          settings,
          horizonDays: 30,
        })
        : null
    ),
    [transactions, subscriptions, recurringIncome, plannedCashflows, settings],
  );
  const forecastData = useMemo(
    () => cashflowForecast?.points.map((point) => ({ date: point.label, balance: point.balance })) ?? [],
    [cashflowForecast],
  );
  const forecastRiskPreview = useMemo(
    () => cashflowForecast?.riskDays.slice(0, 4) ?? [],
    [cashflowForecast],
  );
  const forecastEventPreview = useMemo(
    () => cashflowForecast?.upcomingEvents.slice(0, 6) ?? [],
    [cashflowForecast],
  );
  const activeSavingsGoal = useMemo(
    () => savingsGoals.find((goal) => goal.active) ?? savingsGoals[savingsGoals.length - 1] ?? null,
    [savingsGoals],
  );
  const savingsGoalPlanner = useMemo(
    () => buildSavingsGoalPlanner({
      goal: activeSavingsGoal,
      transactions,
      subscriptions,
      recurringIncome,
      plannedCashflows,
      settings,
    }),
    [activeSavingsGoal, transactions, subscriptions, recurringIncome, plannedCashflows, settings],
  );
  const moneyMetricExplanations = useMemo(
    () => buildMoneyMetricExplanations({
      settings,
      transactions,
      subscriptions,
      recurringIncome,
      plannedCashflows,
      activeGoal: activeSavingsGoal,
      budgetSnapshot,
      cashflowForecast,
      goalPlanner: savingsGoalPlanner,
      referenceDate: liveNow,
    }),
    [
      settings,
      transactions,
      subscriptions,
      recurringIncome,
      plannedCashflows,
      activeSavingsGoal,
      budgetSnapshot,
      cashflowForecast,
      savingsGoalPlanner,
      liveNow,
    ],
  );
  const activeMoneyExplanationCard = useMemo(
    () => moneyMetricExplanations.find((item) => item.id === activeMoneyExplanation) ?? null,
    [moneyMetricExplanations, activeMoneyExplanation],
  );
  const subscriptionSuggestions = useMemo(
    () => detectSubscriptionCandidates(
      transactions,
      subscriptions,
      new Set(dismissedSubscriptionSuggestions),
    ),
    [transactions, subscriptions, dismissedSubscriptionSuggestions],
  );
  const computedCoachMemories = useMemo(
    () => buildCoachMemories({
      transactions,
      subscriptions,
      dismissedSubscriptionSuggestions,
      referenceDate: liveNow,
    }),
    [transactions, subscriptions, dismissedSubscriptionSuggestions, liveNow],
  );
  const computedCoachMemoriesKey = useMemo(
    () => JSON.stringify(computedCoachMemories),
    [computedCoachMemories],
  );
  const storedCoachMemoriesKey = useMemo(
    () => JSON.stringify(coachMemories.map((memory) => ({
      kind: memory.kind,
      title: memory.title,
      summary: memory.summary,
      evidence: memory.evidence,
      confidence: memory.confidence,
      updatedAt: memory.updatedAt,
    }))),
    [coachMemories],
  );
  const coachMemoryHighlights = useMemo(
    () => coachMemories.slice(0, 3),
    [coachMemories],
  );
  const todayIso = useMemo(() => format(liveNow, "yyyy-MM-dd"), [liveNow]);
  const todayContextNote = useMemo(
    () => dailyContextNotes.find((note) => note.date === todayIso) ?? null,
    [dailyContextNotes, todayIso],
  );
  const recentAiVisibleNotes = useMemo(
    () => dailyContextNotes
      .filter((note) => note.aiVisible && (note.title.trim() || note.body.trim()))
      .slice(0, 5),
    [dailyContextNotes],
  );
  const recentDailyContextNotes = useMemo(
    () => dailyContextNotes.slice(0, 6),
    [dailyContextNotes],
  );
  const todayNotePreview = useMemo(() => {
    const source = (todayContextNote?.body || todayContextNote?.title || "").trim();
    if (!source) return "Capture what happened, why it mattered, and what to remember next.";
    return source.length > 110 ? `${source.slice(0, 110).trim()}...` : source;
  }, [todayContextNote]);
  useEffect(() => {
    if (computedCoachMemoriesKey === storedCoachMemoriesKey) return;
    void replaceCoachMemories(computedCoachMemories);
  }, [computedCoachMemories, computedCoachMemoriesKey, storedCoachMemoriesKey, replaceCoachMemories]);
  useEffect(() => {
    setDailyContextNoteDraft({
      title: todayContextNote?.title ?? "",
      body: todayContextNote?.body ?? "",
      tags: todayContextNote?.tags.join(", ") ?? "",
      aiVisible: todayContextNote?.aiVisible ?? true,
    });
    setDailyContextNoteStatus("");
  }, [todayContextNote?.id, todayContextNote?.updatedAt]);
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
  const { streakDays, streakCarryDays, streakAtRisk } = useMemo(() => {
    const activityDays = new Set<string>();
    for (const tx of transactions) {
      const d = parseISO(tx.date);
      if (!Number.isNaN(+d)) activityDays.add(format(d, "yyyy-MM-dd"));
    }
    const snapshotSignalsDay = (snap: RoutineDaySnapshot) =>
      (snap.timelineEvents?.length ?? 0) > 0 ||
      (snap.tasks?.length ?? 0) > 0 ||
      (snap.meals?.length ?? 0) > 0 ||
      snap.dayRating != null;
    for (const [day, snap] of Object.entries(routineHistory)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (snapshotSignalsDay(snap)) activityDays.add(day);
    }
    const tkLive = format(liveNow, "yyyy-MM-dd");
    const routineLiveToday =
      timelineEvents.some((e) => (e.date ?? tkLive) === tkLive) ||
      tasks.length > 0 ||
      meals.length > 0 ||
      dayRating != null;
    if (routineLiveToday) activityDays.add(tkLive);

    const todayStart = startOfDay(liveNow);
    let streakDaysCount = 0;
    for (let i = 0; i < 366 * 8; i += 1) {
      const key = format(subDays(todayStart, i), "yyyy-MM-dd");
      if (!activityDays.has(key)) break;
      streakDaysCount += 1;
    }

    let streakCarryDaysCount = 0;
    for (let i = 1; i < 366 * 8; i += 1) {
      const key = format(subDays(todayStart, i), "yyyy-MM-dd");
      if (!activityDays.has(key)) break;
      streakCarryDaysCount += 1;
    }

    const todayHasCredit = activityDays.has(tkLive);
    const streakAtRiskFlag = streakCarryDaysCount >= 1 && !todayHasCredit;

    return {
      streakDays: streakDaysCount,
      streakCarryDays: streakCarryDaysCount,
      streakAtRisk: streakAtRiskFlag,
    };
  }, [transactions, routineHistory, liveNow, timelineEvents, tasks, meals, dayRating]);
  /** Rotate through a vivid palette so the streak badge looks clearly different each day. */
  const streakIconSurfaceStyle = useMemo((): CSSProperties => {
    const dayIndex = differenceInCalendarDays(startOfDay(liveNow), startOfDay(new Date(2020, 0, 1)));
    const paletteIndex = ((dayIndex % STREAK_DAY_SURFACES.length) + STREAK_DAY_SURFACES.length) % STREAK_DAY_SURFACES.length;
    return STREAK_DAY_SURFACES[paletteIndex];
  }, [liveNow]);
  const sortedTimelineEvents = useMemo(() => {
    const tk = format(liveNow, "yyyy-MM-dd");
    const copy = timelineEvents.filter((e) => (e.date ?? tk) === tk);
    copy.sort((a, b) =>
      timelineSortAsc ? timelineStartMinutes(a) - timelineStartMinutes(b) : timelineStartMinutes(b) - timelineStartMinutes(a),
    );
    return copy;
  }, [timelineEvents, timelineSortAsc, liveNow]);
  const currentTimelineBlock = useMemo(() => {
    const now = new Date();
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    const active = sortedTimelineEvents.find((event) => {
      const start = timelineStartMinutes(event);
      const duration = Math.max(15, event.durationMinutes ?? 60);
      return minuteOfDay >= start && minuteOfDay < start + duration;
    });
    if (!active) return null;
    const endMinute = timelineStartMinutes(active) + Math.max(15, active.durationMinutes ?? 60);
    return { ...active, minutesLeft: Math.max(0, endMinute - minuteOfDay) };
  }, [sortedTimelineEvents, currentHour]);
  const nextTimelineBlock = useMemo(() => {
    const now = new Date();
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    return sortedTimelineEvents.find((event) => timelineStartMinutes(event) > minuteOfDay) ?? null;
  }, [sortedTimelineEvents, currentHour]);
  const nextTimelineBlockEtaMinutes = useMemo(() => {
    if (!nextTimelineBlock) return 0;
    const nowMinute = liveNow.getHours() * 60 + liveNow.getMinutes();
    return Math.max(0, timelineStartMinutes(nextTimelineBlock) - nowMinute);
  }, [nextTimelineBlock, liveNow]);
  const taskPriorityWeight: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };
  const todayChecklist = useMemo(
    () => [...tasks].sort((a, b) => taskPriorityWeight[a.priority] - taskPriorityWeight[b.priority]),
    [tasks],
  );
  const openChecklistTasks = useMemo(() => todayChecklist.filter((t) => !t.done), [todayChecklist]);
  const doneChecklistTasks = useMemo(() => todayChecklist.filter((t) => t.done), [todayChecklist]);
  const checklistProgressPct =
    tasks.length === 0 ? 0 : Math.round((doneChecklistTasks.length / tasks.length) * 100);
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
  const dailyBriefing = useMemo(() => {
    const openTasks = Math.max(0, tasks.length - doneTasks);
    const moneySignal = todayRemaining >= 0 ? "on track" : "over target";
    const mealSignal = mealStats.planned > 0 ? `${mealStats.completed}/${mealStats.planned} meals done` : "no meals planned yet";
    const taskSignal = tasks.length > 0 ? `${doneTasks}/${tasks.length} tasks done` : "No tasks set yet";
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
  const recentNewsItems = useMemo(
    () => sortedNews.slice(0, 6),
    [sortedNews],
  );
  const leadNewsItem = recentNewsItems[0] ?? null;
  const coachSuggestions = useMemo(() => {
    const items: string[] = [];
    if (todayRemaining < 0) items.push(`Slow spending this morning. You are ${money(Math.abs(todayRemaining))} over today's target.`);
    else items.push(`You are within budget with about ${money(todayRemaining)} left for today.`);
    if (coachMemoryHighlights[0]) items.push(coachMemoryHighlights[0].summary);
    if (tasks.length > 0 && doneTasks < tasks.length) items.push(`Complete 1 priority task now (${doneTasks}/${tasks.length} done).`);
    else if (tasks.length > 0) items.push("Great momentum: all planned tasks are completed.");
    if (mealStats.planned > 0 && mealStats.completed < mealStats.planned) items.push(`Meal plan is ${mealStats.completed}/${mealStats.planned}. Prep next meal early.`);
    if (dailyBriefing.nextBills > 0) items.push(`${dailyBriefing.nextBills} bill(s) due in the next 3 days. Keep a cash buffer.`);
    if (leadNewsItem) items.push(`Somaliland watch: ${leadNewsItem.title}`);
    return items.slice(0, 4);
  }, [todayRemaining, coachMemoryHighlights, tasks.length, doneTasks, mealStats, dailyBriefing.nextBills, leadNewsItem]);
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
  const dailyAllowanceStatusText = useMemo(() => {
    if (todaySpent <= 0) return "Nothing spent yet today. Your full allowance is available.";
    if (todayRemaining < 0) return `You've gone ${money(Math.abs(todayRemaining))} over today. Keep tomorrow lighter.`;
    return `You're on track. ${money(todayRemaining)} left for today.`;
  }, [todaySpent, todayRemaining]);
  useEffect(() => {
    setMonthlyRealDraft(String(Number.isFinite(monthlyRealBalance) ? Number(monthlyRealBalance.toFixed(2)) : 0));
  }, [monthlyRealBalance]);

  const patchPushNotificationMessage = useCallback(
    (id: PushNotificationKind, patch: { title?: string; body?: string }) => {
      const prevAll = settings?.pushNotificationMessages ?? {};
      const merged = { ...prevAll[id], ...patch };
      const titleTrim = (merged.title ?? "").trim();
      const bodyTrim = (merged.body ?? "").trim();
      const next = { ...prevAll };
      if (!titleTrim && !bodyTrim) {
        delete next[id];
      } else {
        next[id] = {
          ...(titleTrim ? { title: titleTrim } : {}),
          ...(bodyTrim ? { body: bodyTrim } : {}),
        };
      }
      updateSettings({
        pushNotificationMessages: Object.keys(next).length > 0 ? next : {},
      });
    },
    [settings, updateSettings],
  );

  const clearPushNotificationMessage = useCallback(
    (id: PushNotificationKind) => {
      const prevAll = { ...(settings?.pushNotificationMessages ?? {}) };
      delete prevAll[id];
      updateSettings({
        pushNotificationMessages: Object.keys(prevAll).length > 0 ? prevAll : {},
      });
    },
    [settings, updateSettings],
  );

  useEffect(() => {
    if (notifState !== "granted") return;
    const badge =
      settings == null
        ? { billsDueThisWeek: 0, highPriorityOpenTasks: 0, overBudgetDays: 0 }
        : {
            billsDueThisWeek: countSubscriptionsDueThisWeek(subscriptions),
            highPriorityOpenTasks: tasks.filter((t) => !t.done && t.priority === "high").length,
            overBudgetDays: countOverBudgetDaysInMonth(transactions, subscriptions, settings),
          };
    void fetch("/api/notification-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        finance: {
          todayRemaining,
          dailyAllowance: safePerDay,
          savePerDay: savePlan.savePerDay,
        },
        tasks: tasks.map((t) => ({ title: t.title, done: t.done, priority: t.priority })),
        subscriptions: subscriptions.map((s) => ({ name: s.name, amount: s.amount, nextBillingDate: s.nextBillingDate })),
        routine: {
          currentBlock: currentTimelineBlock?.title || "",
          nextBlock: nextTimelineBlock?.title || "",
          nextBlockTime: nextTimelineBlock
            ? (nextTimelineBlock.hour > 12 ? `${nextTimelineBlock.hour - 12}pm` : nextTimelineBlock.hour === 12 ? "12pm" : `${nextTimelineBlock.hour}am`)
            : "",
        },
        badge,
        pushNotificationMessages: settings?.pushNotificationMessages ?? {},
      }),
    }).catch(() => {});
  }, [
    notifState,
    todayRemaining,
    safePerDay,
    savePlan.savePerDay,
    tasks,
    subscriptions,
    transactions,
    settings,
    currentTimelineBlock,
    nextTimelineBlock,
  ]);
  useEffect(() => {
    if (notifState !== "granted") return;
    void fetch("/api/spending-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        todayRemaining,
        overBy: Math.max(0, Math.abs(Math.min(0, todayRemaining))),
      }),
    }).catch(() => {});
  }, [notifState, transactions.length, todayRemaining]);
  useEffect(() => {
    if (!streakProtectionEnabled || notifState !== "granted" || !pushConnected || !streakAtRisk) return;
    const dayKey = format(new Date(), "yyyy-MM-dd");
    let skip = false;
    try {
      skip = localStorage.getItem("zero_streak_protect_sched_v1") === dayKey;
    } catch {
      // ignore
    }
    if (skip) return;

    const nowMs = Date.now();
    const anchor = new Date();
    const evening = new Date(anchor);
    evening.setHours(20, 0, 0, 0);
    let delayMs = evening.getTime() - nowMs;
    if (delayMs <= 0) {
      const late = new Date(anchor);
      late.setHours(22, 45, 0, 0);
      delayMs = late.getTime() - nowMs;
    }
    if (delayMs <= 0) delayMs = 90_000;
    if (delayMs > 24 * 60 * 60 * 1000) return;

    void fetch("/api/schedule-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "streak_protect",
        data: { streakDays: streakCarryDays },
        delayMs: Math.floor(delayMs),
      }),
    })
      .then((res) => {
        if (!res.ok) return;
        try {
          localStorage.setItem("zero_streak_protect_sched_v1", dayKey);
        } catch {
          // ignore
        }
      })
      .catch(() => {});
  }, [streakProtectionEnabled, notifState, pushConnected, streakAtRisk, streakCarryDays]);
  const weeklyDueBills = useMemo(
    () => upcoming.filter((bill) => {
      const daysAway = differenceInCalendarDays(parseISO(bill.dueDate), startOfDay(new Date()));
      return daysAway >= 0 && daysAway <= 7;
    }),
    [upcoming],
  );

  /** Opening snapshot when the assistant chat is empty — reflects live money, routine, and bills. */
  const coachZeroSituationIntro = useMemo(() => {
    if (!settings) {
      return "Finish loading your profile — then I can tie this to your balances and routine.";
    }
    const name = (settings.profileName || "").trim();
    const address = name ? `${name}, here's what's live:` : "Here's what's live:";
    const tod =
      currentHour < 12 ? "Morning" : currentHour < 17 ? "Afternoon" : currentHour < 22 ? "Evening" : "Late night";

    const bits: string[] = [`${address} ${tod.toLowerCase()} —`];

    if (safePerDay <= 0) {
      bits.push("set balance and bills in Settings so I can read today's runway.");
    } else if (todayRemaining < 0) {
      bits.push(
        `you're about ${money(Math.abs(todayRemaining))} past today's allowance guide (${money(todaySpent)} logged vs ~${money(safePerDay)} daily band).`,
      );
    } else {
      bits.push(
        `today you've logged ${money(todaySpent)} spend with roughly ${money(todayRemaining)} left vs ~${money(safePerDay)} daily guide.`,
      );
    }

    if (tasks.length === 0) {
      bits.push("checklist is empty.");
    } else {
      const highOpen = tasks.filter((t) => !t.done && t.priority === "high").length;
      bits.push(
        `tasks ${doneTasks}/${tasks.length} done${highOpen ? ` (${highOpen} high-priority still open)` : ""}.`,
      );
    }

    if (mealStats.planned > 0) {
      bits.push(`meals ${mealStats.completed}/${mealStats.planned} marked done.`);
    }

    if (currentTimelineBlock) {
      bits.push(`timeline: in "${currentTimelineBlock.title}" — ~${currentTimelineBlock.minutesLeft} min left.`);
    } else if (nextTimelineBlock && nextTimelineBlockEtaMinutes > 0) {
      bits.push(`next block "${nextTimelineBlock.title}" in ~${nextTimelineBlockEtaMinutes} min.`);
    } else if (sortedTimelineEvents.length > 0) {
      bits.push(`${sortedTimelineEvents.length} block(s) today (${sortedTimelineEvents[0]?.title ?? "timeline"} next).`);
    } else {
      bits.push("nothing on today's timeline yet.");
    }

    if (weeklyDueBills.length > 0) {
      bits.push(`${weeklyDueBills.length} bill(s) due in the next week.`);
    }

    if (streakAtRisk) {
      bits.push("streak: log a transaction or routine touch before midnight to keep the chain.");
    }

    if (coachMemoryHighlights[0]) {
      bits.push(`coach memory: ${coachMemoryHighlights[0].summary.toLowerCase()}`);
    }

    bits.push("Say what you want — I'll run changes when you ask.");
    return bits.join(" ");
  }, [
    settings,
    currentHour,
    safePerDay,
    todayRemaining,
    todaySpent,
    tasks,
    doneTasks,
    mealStats.planned,
    mealStats.completed,
    currentTimelineBlock,
    nextTimelineBlock,
    nextTimelineBlockEtaMinutes,
    sortedTimelineEvents,
    weeklyDueBills.length,
    streakAtRisk,
    coachMemoryHighlights,
  ]);

  const allowanceProgressTone = useMemo(() => {
    if (todayRemaining < 0 || allowanceProgressPct >= 90) return "danger";
    if (allowanceProgressPct >= 60) return "warn";
    return "safe";
  }, [allowanceProgressPct, todayRemaining]);
  const recentTransactions = useMemo(() => transactions.slice(0, 5), [transactions]);
  const recentTransactionSummary = useMemo(() => {
    const expense = recentTransactions.filter((t) => t.type === "expense").reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
    const income = recentTransactions.filter((t) => t.type === "income").reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
    return {
      count: recentTransactions.length,
      expense,
      income,
    };
  }, [recentTransactions]);
  const openTasksSorted = useMemo(
    () => tasks.filter((t) => !t.done).sort((a, b) => taskPriorityWeight[a.priority] - taskPriorityWeight[b.priority]),
    [tasks],
  );
  const topOpenTasks = useMemo(() => openTasksSorted.slice(0, 2), [openTasksSorted]);
  const next48HourBill = useMemo(
    () => upcoming
      .map((bill) => {
        const dueMs = +new Date(bill.dueDate);
        const diffHours = Math.round((dueMs - +liveNow) / (60 * 60 * 1000));
        return { ...bill, dueMs, diffHours };
      })
      .filter((bill) => bill.diffHours <= 48)
      .sort((a, b) => a.dueMs - b.dueMs)[0] ?? null,
    [upcoming, liveNow],
  );
  const liveOverview = useMemo(() => {
    const warningLabel = next48HourBill
      ? (next48HourBill.diffHours < 0
        ? "overdue"
        : next48HourBill.diffHours <= 24
          ? "due tomorrow"
          : "due soon")
      : "";
    return (
      <section className="card live-overview-card">
        <div className="live-overview-head">
          <p className="live-label">LIVE OVERVIEW</p>
          <span className={`live-money-status ${todayRemaining < 0 ? "over" : "track"}`}>{todayRemaining < 0 ? "Over budget" : "On track"}</span>
        </div>
        <div className="live-overview-grid">
          <article className="live-overview-tile">
            <p className="live-label">NOW</p>
            {currentTimelineBlock ? (
              <>
                <h3>{currentTimelineBlock.title}</h3>
                <p className="muted">{currentTimelineBlock.category.toUpperCase()} · ends in {currentTimelineBlock.minutesLeft} min</p>
              </>
            ) : (
              <p className="muted">Nothing scheduled <button type="button" className="inline-link" onClick={() => setTab("Insights")}>+ Add</button></p>
            )}
          </article>
          <article className="live-overview-tile">
            <p className="live-label">NEXT</p>
            {nextTimelineBlock ? (
              <>
                <h3>{nextTimelineBlock.title}</h3>
                <p className="muted">
                  {nextTimelineBlock.hour > 12 ? `${nextTimelineBlock.hour - 12}pm` : nextTimelineBlock.hour === 12 ? "12pm" : `${nextTimelineBlock.hour}am`} · in {nextTimelineBlockEtaMinutes} min
                </p>
              </>
            ) : (
              <p className="muted">Free for the rest of the day</p>
            )}
          </article>
          <article className="live-overview-tile">
            <p className="live-label">TASKS</p>
            {topOpenTasks.length > 0 ? (
              <>
                {topOpenTasks.map((task) => (
                  <p key={task.id} className="live-task-line">
                    <span>{task.title}</span>
                    <span className={`priority-dot ${task.priority}`} />
                  </p>
                ))}
                {openTasksSorted.length > 2 && <p className="muted">{openTasksSorted.length - 2} more tasks</p>}
              </>
            ) : (
              <p className="muted">Nothing on your list <button type="button" className="inline-link" onClick={() => setTab("Insights")}>+ Add</button></p>
            )}
          </article>
          <article className="live-overview-tile live-overview-money">
            <p className="live-label">MONEY</p>
            <h3>{money(todayRemaining)} left today</h3>
            <p className={`live-money-status ${todayRemaining < 0 ? "over" : "track"}`}>{todayRemaining < 0 ? "Over budget" : "On track"}</p>
          </article>
        </div>
        <div className="live-overview-foot">
          {savePlan.savePerDay > 0 && (
            <button type="button" className="savings-pulse-row live-overview-action" onClick={() => setSavingPulseDone((v) => !v)}>
              <span className="live-label">SAVINGS PULSE</span>
              <span>Save {money(savePlan.savePerDay)} today</span>
              <span className={`pulse-toggle ${savingPulseDone ? "done" : ""}`}>{savingPulseDone ? "✓" : ""}</span>
            </button>
          )}
          {next48HourBill && (
            <button type="button" className="bill-alert-row live-overview-action" onClick={() => setTab("Subscriptions")}>
              <span className="live-label">BILLS</span>
              <span>⚠ {next48HourBill.name} {warningLabel}</span>
            </button>
          )}
        </div>
      </section>
    );
  }, [
    currentTimelineBlock,
    nextTimelineBlock,
    nextTimelineBlockEtaMinutes,
    topOpenTasks,
    openTasksSorted.length,
    todayRemaining,
    savePlan.savePerDay,
    savingPulseDone,
    next48HourBill,
  ]);
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
    const somalilandLine = leadNewsItem
      ? "Somaliland updates are already moving this morning — stay informed, but keep your focus tight."
      : "Somaliland morning energy is calm right now — perfect time to make your first strong move.";
    const memoryLine = coachMemoryHighlights[0]
      ? `Coach memory: ${coachMemoryHighlights[0].summary}`
      : "Coach memory is still learning from your transaction history.";
    const nudge = tasks.length === 0
      ? "One move: write one priority before 9am and finish it first."
      : "One move: finish your top task before you check socials again.";
    const combined = `${greeting}, ${preferredName}. ${dayPart} is here — make it count. ${budgetLine} ${taskMealLine} ${timelineLine} ${somalilandLine} ${memoryLine} ${nudge}`;
    return combined.split(/\s+/).slice(0, 80).join(" ");
  }, [settings?.profileName, currentHour, todayRemaining, tasks.length, doneTasks, mealStats.planned, mealStats.completed, timelineEvents.length, leadNewsItem, coachMemoryHighlights]);
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
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: "UPDATE_NOTIFICATION_DATA", payload: { upcomingCount: upcoming.length } });
    await fetch("/api/send-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "custom", data: { title: "Push ready", message: "Schedules are active." } }),
    }).catch(() => {});

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
    try {
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasksCount: tasks.filter((t) => !t.done).length,
          amount: todayRemaining,
          block: nextTimelineBlock?.title || currentTimelineBlock?.title || "Focus",
          time: nextTimelineBlock ? formatTimelineClock(nextTimelineBlock) : "9:00 AM",
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
      setPushStatusDetail("Push server not reachable.");
    }
  };
  const scheduleTestNotification = () => {
    if (notifState !== "granted") return;
    const parsed = Number(testNotifDelaySec);
    const delaySec = Math.max(1, Math.min(3600, Number.isFinite(parsed) ? Math.floor(parsed) : 10));
    setTestNotifDelaySec(String(delaySec));
    const fireAt = Date.now() + delaySec * 1000;
    setScheduledNotifAt(fireAt);
    void fetch("/api/schedule-notification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "morning_briefing",
        data: {
          tasksCount: tasks.filter((t) => !t.done).length,
          amount: todayRemaining,
          block: nextTimelineBlock?.title || currentTimelineBlock?.title || "Focus",
          time: nextTimelineBlock ? formatTimelineClock(nextTimelineBlock) : "9:00 AM",
        },
        delayMs: delaySec * 1000,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        setPushStatusDetail("Server schedule failed.");
        return;
      }
      setPushStatusDetail(`Notification scheduled on server in ${delaySec}s.`);
    }).catch(() => {
      setPushStatusDetail("Server schedule unreachable.");
    });
  };
  const applyTemplateToToday = () => {
    if (routineTemplate.length === 0) return;
    const tk = format(new Date(), "yyyy-MM-dd");
    const mapped: TimelineEvent[] = routineTemplate.map((block) => ({
      id: Date.now() + Math.floor(Math.random() * 1000) + block.id,
      title: block.name,
      hour: block.hour,
      durationMinutes: block.durationMinutes,
      category: block.category,
      date: tk,
    }));
    setTimelineEvents(mapped.sort((a, b) => timelineStartMinutes(a) - timelineStartMinutes(b)));
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
    const now = new Date();
    let delaySeconds = Math.max(60, item.delaySeconds || 1800);
    if (item.mode === "clock" && item.clockTime) {
      const [hRaw, mRaw] = item.clockTime.split(":");
      const h = Math.max(0, Math.min(23, Number(hRaw) || 0));
      const m = Math.max(0, Math.min(59, Number(mRaw) || 0));
      const next = new Date(now);
      next.setHours(h, m, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      delaySeconds = Math.max(60, Math.round((next.getTime() - now.getTime()) / 1000));
    }
    try {
      await fetch("/api/schedule-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "task_still_open",
          data: { task: item.label, message: item.message?.trim() || item.label },
          delayMs: delaySeconds * 1000,
        }),
      });
    } catch {
      // ignore schedule failures here
    }
  };
  const runAssistantAutomation = async (question: string) => {
    const notes: string[] = [];
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
          type: "custom",
          data: { title: "Coach zero", message: reminderMessage },
          delayMs: delaySeconds * 1000,
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
          type: "custom",
          data: { title: "Coach zero", message: "Review priorities and stay on target today." },
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
    const scenarioPreview = simulateWhatIfScenario(text, transactions, subscriptions, settings);
    const affordabilityAssessment = assessAffordability({
      question: text,
      transactions,
      subscriptions,
      recurringIncome,
      plannedCashflows,
      settings,
      activeGoal: activeSavingsGoal,
      referenceDate: liveNow,
    });
    const matchedMoneyExplanation = matchMoneyExplanationQuestion(text, moneyMetricExplanations);
    const recentScenarioContext = whatIfScenarios
      .slice(0, 3)
      .map((s) => `${s.title}: month-end ${money(s.simulatedMonthEnd)} vs baseline ${money(s.currentMonthEnd)}.`)
      .join("\n");
    const affordabilityContext = affordabilityAssessment
      ? [
        `Deterministic affordability check for ${money(affordabilityAssessment.amount)}:`,
        `Short-term: ${affordabilityAssessment.shortTermVerdict}. ${affordabilityAssessment.shortTermReason}`,
        `Today after purchase: ${money(affordabilityAssessment.todayAfterPurchase)} (safe now ${money(affordabilityAssessment.safeToday)}).`,
        affordabilityAssessment.weekEndBalance != null ? `Week-end balance: ${money(affordabilityAssessment.weekEndBalance)}.` : null,
        affordabilityAssessment.monthEndBalance != null ? `Month-end balance: ${money(affordabilityAssessment.monthEndBalance)}.` : null,
        affordabilityAssessment.goal
          ? `Goal impact: ${affordabilityAssessment.goal.title} ${affordabilityAssessment.goal.delayed ? `delays about ${affordabilityAssessment.goal.delayDays ?? 0} day(s)` : "stays on track"}.`
          : null,
      ].filter(Boolean).join("\n")
      : "";
    const explanationContext = matchedMoneyExplanation
      ? `Deterministic explanation baseline:\n${matchedMoneyExplanation.summary}\n${matchedMoneyExplanation.bullets.map((line) => `- ${line}`).join("\n")}`
      : "";
    const enrichedQuestion = scenarioPreview
      ? `${text}\n\nWhat-if simulator baseline:\n${scenarioPreview.baseline.changes.join("\n")}\nProjected month-end: ${money(scenarioPreview.baseline.simulatedMonthEnd)} (current path ${money(scenarioPreview.baseline.currentMonthEnd)}).${recentScenarioContext ? `\n\nRecent scenarios:\n${recentScenarioContext}` : ""}${affordabilityContext ? `\n\n${affordabilityContext}` : ""}${explanationContext ? `\n\n${explanationContext}` : ""}`
      : `${text}${recentScenarioContext ? `\n\nRecent scenarios:\n${recentScenarioContext}` : ""}${affordabilityContext ? `\n\n${affordabilityContext}` : ""}${explanationContext ? `\n\n${explanationContext}` : ""}`;
    if (scenarioPreview) {
      setWhatIfScenarios((prev) => [
        {
          id: Date.now(),
          prompt: text,
          title: text.length > 56 ? `${text.slice(0, 56)}...` : text,
          changes: scenarioPreview.baseline.changes,
          currentMonthEnd: scenarioPreview.baseline.currentMonthEnd,
          simulatedMonthEnd: scenarioPreview.baseline.simulatedMonthEnd,
          totalSavings: scenarioPreview.baseline.totalSavings,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 12));
    }
    const historyBeforeQuestion = [...chat].slice(-10) as Array<{ role: "assistant" | "user"; text: string }>;
    const nextHistory = [...historyBeforeQuestion, { role: "user", text }] as Array<{ role: "assistant" | "user"; text: string }>;
    setChat(nextHistory);
    setAssistantBusy(true);
    try {
      const actionNotes = await runAssistantAutomation(text);
      let streamedAnswer = "";
      let streamMounted = false;
      const answer = await askGroqFinanceAssistant({
        question: enrichedQuestion,
        chatHistory: historyBeforeQuestion,
        transactions,
        subscriptions,
        recurringIncome,
        plannedCashflows,
        settings,
        forecastData,
        cashflowForecastSummary: {
          threshold: cashflowForecast?.threshold ?? 0,
          baselineDailySpend: cashflowForecast?.baselineDailySpend ?? 0,
          salaryContext: cashflowForecast?.salaryContext,
          spendingProfile: cashflowForecast?.spendingProfile,
          lowestPoint: cashflowForecast?.lowestPoint
            ? { date: cashflowForecast.lowestPoint.date, balance: cashflowForecast.lowestPoint.balance }
            : null,
          nextRiskDay: cashflowForecast?.nextRiskDay
            ? { date: cashflowForecast.nextRiskDay.date, balance: cashflowForecast.nextRiskDay.balance }
            : null,
          nextPayday: cashflowForecast?.nextPayday
            ? {
              date: cashflowForecast.nextPayday.date,
              label: cashflowForecast.nextPayday.label,
              amount: cashflowForecast.nextPayday.amount,
            }
            : null,
          riskDays: (cashflowForecast?.riskDays ?? []).slice(0, 8).map((point) => ({
            date: point.date,
            balance: point.balance,
          })),
          upcomingEvents: (cashflowForecast?.upcomingEvents ?? []).slice(0, 12).map((event) => ({
            date: event.date,
            label: event.label,
            amount: event.amount,
            kind: event.kind,
          })),
          checkpoints: cashflowForecast?.checkpoints
            ? {
              nextPayday: cashflowForecast.checkpoints.nextPayday
                ? {
                  date: cashflowForecast.checkpoints.nextPayday.date,
                  bestBalance: cashflowForecast.checkpoints.nextPayday.bestBalance,
                  likelyBalance: cashflowForecast.checkpoints.nextPayday.likelyBalance,
                  worstBalance: cashflowForecast.checkpoints.nextPayday.worstBalance,
                }
                : null,
              monthEnd: cashflowForecast.checkpoints.monthEnd
                ? {
                  date: cashflowForecast.checkpoints.monthEnd.date,
                  bestBalance: cashflowForecast.checkpoints.monthEnd.bestBalance,
                  likelyBalance: cashflowForecast.checkpoints.monthEnd.likelyBalance,
                  worstBalance: cashflowForecast.checkpoints.monthEnd.worstBalance,
                }
                : null,
            }
            : undefined,
          categoryTrends: (cashflowForecast?.categoryTrends ?? []).slice(0, 6).map((trend) => ({
            category: trend.category,
            changePct: trend.changePct,
            direction: trend.direction,
            spendClass: trend.spendClass,
          })),
          requiredCorrection: cashflowForecast?.requiredCorrection
            ? {
              amountPerDay: cashflowForecast.requiredCorrection.amountPerDay,
              days: cashflowForecast.requiredCorrection.days,
              targetDate: cashflowForecast.requiredCorrection.targetDate,
              targetLabel: cashflowForecast.requiredCorrection.targetLabel,
            }
            : null,
          irregularExpenses: (cashflowForecast?.irregularExpenses ?? []).slice(0, 5).map((expense) => ({
            date: expense.date,
            label: expense.label,
            amount: expense.amount,
            category: expense.category,
          })),
        },
        savingsGoalSummary: savingsGoalPlanner
          ? {
            goal: {
              title: savingsGoalPlanner.goal.title,
              targetAmount: savingsGoalPlanner.goal.targetAmount,
              targetDate: savingsGoalPlanner.goal.targetDate,
            },
            requiredMonthly: savingsGoalPlanner.requiredMonthly,
            projectedNaturalSavings: savingsGoalPlanner.projectedNaturalSavings,
            plans: savingsGoalPlanner.plans.map((plan) => ({
              kind: plan.kind,
              label: plan.label,
              monthlyContribution: plan.monthlyContribution,
              projectedSaved: plan.projectedSaved,
              remainingGap: plan.remainingGap,
              hitsGoal: plan.hitsGoal,
              bufferRisk: plan.bufferRisk,
              confidence: plan.confidence,
            })),
          }
          : { goal: null },
        metricExplanationSummary: moneyMetricExplanations.map((item) => ({
          id: item.id,
          title: item.title,
          summary: item.summary,
          bullets: item.bullets,
        })),
        coachMemorySummary: coachMemories.map((memory) => ({
          kind: memory.kind,
          title: memory.title,
          summary: memory.summary,
          confidence: memory.confidence,
          evidence: memory.evidence,
        })),
        dailyNoteSummary: recentAiVisibleNotes.map((note) => ({
          date: note.date,
          title: note.title,
          body: note.body,
          tags: note.tags,
          aiVisible: note.aiVisible,
          updatedAt: note.updatedAt,
        })),
        decisionSummary: affordabilityAssessment
          ? {
            amount: affordabilityAssessment.amount,
            shortTermVerdict: affordabilityAssessment.shortTermVerdict,
            shortTermReason: affordabilityAssessment.shortTermReason,
            safeToday: affordabilityAssessment.safeToday,
            todayAfterPurchase: affordabilityAssessment.todayAfterPurchase,
            weekEndBalance: affordabilityAssessment.weekEndBalance,
            monthEndBalance: affordabilityAssessment.monthEndBalance,
            createsRiskDay: affordabilityAssessment.createsRiskDay,
            nextRiskDate: affordabilityAssessment.nextRiskDate,
            goal: affordabilityAssessment.goal,
          }
          : undefined,
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
            date: e.date,
            hour: e.hour,
            startMinute: e.startMinute,
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
          const visible = streamedVisibleReply(streamedAnswer);
          if (!streamMounted) {
            streamMounted = true;
            setChat((c) => [...c, { role: "assistant", text: visible }]);
            return;
          }
          setChat((c) => {
            if (c.length === 0) return [{ role: "assistant", text: visible }];
            const last = c[c.length - 1];
            if (last.role !== "assistant") return [...c, { role: "assistant", text: visible }];
            return [...c.slice(0, -1), { ...last, text: visible }];
          });
        },
      });
      setAssistantEngine("groq");
      setAssistantEngineReason("");
      const fullRaw = streamedAnswer.trim() || answer;
      const { visible: prose, actionsJson } = stripActionMarkers(fullRaw);
      let automationFooter = "";
      let decisionFooter = "";
      if (actionsJson) {
        try {
          const payload = JSON.parse(sanitizeActionsMarkerBody(actionsJson)) as unknown;
          const res = await executeAssistantPayload(payload, {
            todayKey: format(liveNow, "yyyy-MM-dd"),
            setTimelineEvents,
            setTasks,
            getTransactions: () => useZeroStore.getState().transactions,
            addTransaction,
            deleteTransaction,
            addSubscription,
            addRecurringIncome,
            addPlannedCashflow,
            addSavingsGoal,
            updateSettings,
            reloadPlanAhead: async () => {
              const rows = await db.table("routinePlans").toArray();
              setPlanAheadItems(rows as PlanAheadItem[]);
            },
          });
          const lines = [...res.applied, ...res.errors.map((e) => `Warning: ${e}`)];
          if (lines.length) automationFooter = `\n\n—\n${lines.join("\n")}`;
        } catch (err) {
          automationFooter = `\n\nWarning: actions could not run (${err instanceof Error ? err.message : "invalid JSON"}).`;
        }
      }
      if (affordabilityAssessment) {
        const decisionLines = [
          `Short-term: ${affordabilityAssessment.shortTermVerdict === "yes" ? "yes" : affordabilityAssessment.shortTermVerdict === "tight" ? "tight" : "not safely"}.`,
          `Today after purchase: ${money(affordabilityAssessment.todayAfterPurchase)}.`,
          affordabilityAssessment.weekEndBalance != null ? `Week-end: ${money(affordabilityAssessment.weekEndBalance)}.` : null,
          affordabilityAssessment.monthEndBalance != null ? `Month-end: ${money(affordabilityAssessment.monthEndBalance)}.` : null,
          affordabilityAssessment.goal
            ? `Goal: ${affordabilityAssessment.goal.delayed ? `delays ${affordabilityAssessment.goal.title} by about ${affordabilityAssessment.goal.delayDays ?? 0} day(s)` : `${affordabilityAssessment.goal.title} stays on pace`}.`
            : null,
        ].filter(Boolean);
        if (decisionLines.length > 0) {
          decisionFooter = `\n\nDecision check:\n- ${decisionLines.join("\n- ")}`;
        }
      }
      let combined = `${prose}${decisionFooter}${automationFooter}`;
      if (actionNotes.length > 0) {
        combined = `${combined}\n\nOther actions:\n- ${actionNotes.join("\n- ")}`;
      }
      setChat((c) => {
        const copy = [...c];
        for (let i = copy.length - 1; i >= 0; i -= 1) {
          if (copy[i].role === "assistant") {
            copy[i] = { ...copy[i], text: combined };
            return copy;
          }
        }
        return [...copy, { role: "assistant", text: combined }];
      });
    } catch (error) {
      const fallback = askFinanceAssistant(
        text,
        transactions,
        subscriptions,
        recurringIncome,
        plannedCashflows,
        settings,
        forecastData,
        activeSavingsGoal,
        coachMemories,
        dailyContextNotes,
      );
      setAssistantEngine("fallback");
      setAssistantEngineReason(error instanceof Error ? error.message : "Unknown Groq error");
      setChat((c) => [...c, { role: "assistant", text: fallback }]);
    } finally {
      setAssistantBusy(false);
    }
  };
  const selectedWhatIfSubscription = useMemo(
    () => subscriptions.find((s) => s.id === whatIfCancelSubscriptionId) ?? null,
    [subscriptions, whatIfCancelSubscriptionId],
  );
  const builderScenarioQuestion = useMemo(() => {
    const cut = `What if I cut ${whatIfCutCategory} by ${Math.max(1, Math.min(80, Math.round(whatIfCutPercent)))}%`;
    if (selectedWhatIfSubscription) return `${cut} and cancel ${selectedWhatIfSubscription.name}?`;
    return `${cut}?`;
  }, [whatIfCutCategory, whatIfCutPercent, selectedWhatIfSubscription]);
  const builderScenarioPreview = useMemo(
    () => (settings ? simulateWhatIfScenario(builderScenarioQuestion, transactions, subscriptions, settings) : null),
    [builderScenarioQuestion, settings, transactions, subscriptions],
  );

  const resetIncomeDraft = useCallback(() => {
    setIncomeDraft(createEmptyRecurringIncomeDraft());
    setIncomeDraftError("");
  }, []);

  const resetPlannedCashflowDraft = useCallback(() => {
    setPlannedCashflowDraft(createEmptyPlannedCashflowDraft());
    setPlannedCashflowDraftError("");
  }, []);

  const toggleMoneyExplanation = useCallback((id: MoneyMetricExplanationId) => {
    setActiveMoneyExplanation((prev) => (prev === id ? null : id));
  }, []);

  const saveDailyContextNote = useCallback(async () => {
    const title = dailyContextNoteDraft.title.trim().slice(0, 120);
    const body = dailyContextNoteDraft.body.trim().slice(0, 1200);
    const tags = dailyContextNoteDraft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!title && !body) {
      setDailyContextNoteStatus("Write a quick note first.");
      return;
    }
    await upsertDailyContextNote({
      date: todayIso,
      title,
      body,
      tags,
      aiVisible: dailyContextNoteDraft.aiVisible,
    });
    setDailyContextNoteStatus(dailyContextNoteDraft.aiVisible ? "Saved for Coach Zero." : "Saved privately for today.");
  }, [dailyContextNoteDraft, todayIso, upsertDailyContextNote]);

  const clearDailyContextNote = useCallback(async () => {
    if (!todayContextNote?.id) {
      setDailyContextNoteDraft(createEmptyDailyContextNoteDraft());
      setDailyContextNoteStatus("");
      return;
    }
    await deleteDailyContextNote(todayContextNote.id);
    setDailyContextNoteDraft(createEmptyDailyContextNoteDraft());
    setDailyContextNoteStatus("Today's note cleared.");
  }, [todayContextNote, deleteDailyContextNote]);

  const saveIncomeDraft = useCallback(async () => {
    const name = incomeDraft.name.trim();
    const amount = Math.abs(Number(incomeDraft.amount) || 0);
    if (!name || amount <= 0 || !incomeDraft.nextDate) {
      setIncomeDraftError("Add a name, positive amount, and next payday date.");
      return;
    }
    const payload: Omit<RecurringIncome, "id" | "createdAt"> = {
      name,
      amount,
      cycle: incomeDraft.cycle,
      nextDate: new Date(incomeDraft.nextDate).toISOString(),
    };
    setIncomeDraftError("");
    if (incomeDraft.id) {
      await updateRecurringIncome(incomeDraft.id, payload);
    } else {
      await addRecurringIncome(payload);
    }
    resetIncomeDraft();
  }, [incomeDraft, addRecurringIncome, resetIncomeDraft, updateRecurringIncome]);

  const savePlannedCashflowDraft = useCallback(async () => {
    const title = plannedCashflowDraft.title.trim();
    const amount = Math.abs(Number(plannedCashflowDraft.amount) || 0);
    if (!title || amount <= 0 || !plannedCashflowDraft.date) {
      setPlannedCashflowDraftError("Add a title, positive amount, and date.");
      return;
    }
    const payload: Omit<PlannedCashflowItem, "id" | "createdAt"> = {
      title,
      amount,
      kind: plannedCashflowDraft.kind,
      date: new Date(plannedCashflowDraft.date).toISOString(),
      category: plannedCashflowDraft.category.trim() || undefined,
    };
    setPlannedCashflowDraftError("");
    if (plannedCashflowDraft.id) {
      await updatePlannedCashflow(plannedCashflowDraft.id, payload);
    } else {
      await addPlannedCashflow(payload);
    }
    resetPlannedCashflowDraft();
  }, [plannedCashflowDraft, addPlannedCashflow, resetPlannedCashflowDraft, updatePlannedCashflow]);

  const dismissSubscriptionSuggestion = useCallback((signature: string) => {
    setDismissedSubscriptionSuggestions((prev) => (
      prev.includes(signature) ? prev : [signature, ...prev].slice(0, 200)
    ));
  }, []);

  const addDetectedSubscription = useCallback(async (candidate: {
    signature: string;
    name: string;
    amount: number;
    cycle: SubscriptionCycle;
    nextBillingDate: string;
  }) => {
    await addSubscription({
      name: candidate.name,
      amount: candidate.amount,
      cycle: candidate.cycle,
      nextBillingDate: new Date(candidate.nextBillingDate).toISOString(),
    });
    dismissSubscriptionSuggestion(candidate.signature);
  }, [addSubscription, dismissSubscriptionSuggestion]);

  useEffect(() => {
    if (!("Notification" in window)) {
      setNotifState("unsupported");
      return;
    }
    setNotifState(Notification.permission as "default" | "granted" | "denied");
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

  const bioLockSupported = bioLockIsSupported();

  if (bioLockNeedsChallenge && !bioLockUnlocked) {
    return (
      <BiometricLockScreen
        onUnlocked={() => setBioLockUnlocked(true)}
        onResetLock={() => {
          const ok = window.confirm("Reset Face ID lock? You can turn it on again in Settings.");
          if (!ok) return;
          bioLockClear();
          setBioLockFeatureEnabled(false);
          setBioLockCredentialPresent(false);
          setBioLockUnlocked(true);
        }}
      />
    );
  }

  if (loading || !settings) return <div className="screen"><div className="skeleton large" /><div className="skeleton" /><div className="skeleton" /></div>;

  return (
    <div className="app-shell">
      <header className="top">
        <div>
          <div className="streak-weather-row">
            <div className="streak-wrap">
              <motion.span
                className="streak-icon"
                style={streakIconSurfaceStyle}
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
            <div
              className="header-hargeisa-weather"
              role="status"
              aria-live="polite"
              aria-label={
                weatherBrief
                  ? `Hargeisa weather, ${Math.round(weatherBrief.currentTempC)} degrees Celsius, ${weatherBrief.currentSummary}`
                  : weatherLoading
                    ? "Loading Hargeisa weather"
                    : "Hargeisa weather unavailable"
              }
            >
              {weatherBrief ? (
                <>
                  <span className="header-hargeisa-temp">{Math.round(weatherBrief.currentTempC)}°</span>
                  <span className="muted header-hargeisa-summary">{weatherBrief.currentSummary}</span>
                </>
              ) : weatherLoading ? (
                <span className="muted header-hargeisa-summary">Hargeisa · …</span>
              ) : (
                <span className="muted header-hargeisa-summary">Hargeisa · —</span>
              )}
            </div>
          </div>
          {streakAtRisk && (
            <p className="streak-protect-banner" role="status">
              Streak protection: <strong>{streakCarryDays}-day</strong> run needs today&apos;s touch — log a transaction or Routine item before midnight.
            </p>
          )}
        </div>
        <p className="muted">{format(new Date(), "EEEE, MMM d")}</p>
      </header>

      <main className="content">
        {tab === "Home" && (
          <div className="home-layout">
            <section
              className={`home-intro regional-brief-card${regionalBriefExpanded ? "" : " regional-brief-card--collapsed"}`}
              aria-labelledby="regional-brief-heading"
            >
              <div className="row regional-brief-top">
                <div className="regional-brief-title-row">
                  <button
                    type="button"
                    className="regional-brief-collapse-btn"
                    aria-expanded={regionalBriefExpanded}
                    aria-controls="regional-brief-body"
                    aria-label={regionalBriefExpanded ? "Collapse Hargeisa section" : "Expand Hargeisa section"}
                    onClick={() => setRegionalBriefExpanded((v) => !v)}
                  >
                    <span className="regional-brief-chevron" aria-hidden />
                  </button>
                  <div className="regional-brief-title-copy">
                    <h2 id="regional-brief-heading" className="home-title regional-brief-title-plain">
                      Hargeisa
                    </h2>
                  </div>
                </div>
                <button type="button" className="news-live-dot" onClick={() => { void refreshRegionalBrief(); }}>
                  {(newsLoading || weatherLoading) ? "Refreshing…" : "Refresh"}
                </button>
              </div>

              <div
                id="regional-brief-body"
                className={`regional-brief-body ${regionalBriefExpanded ? "is-expanded" : "is-collapsed"}`}
                aria-hidden={!regionalBriefExpanded}
              >
                <div className="regional-brief-grid">
                <div className="regional-brief-panel regional-brief-panel--weather">
                  <div className="regional-panel-head">
                    <span className="regional-panel-kicker">Forecast</span>
                  </div>
                  {weatherLoading && !weatherBrief && (
                    <p className="muted">Loading…</p>
                  )}
                  {!weatherLoading && weatherError && !weatherBrief && (
                    <p className="muted">{weatherError}</p>
                  )}
                  {weatherBrief && (
                    <>
                      {(() => {
                        const t = Math.round(weatherBrief.currentTempC);
                        const lo = Math.round(weatherBrief.todayLowC);
                        const hi = Math.round(weatherBrief.todayHighC);
                        const rawSummary = weatherBrief.currentSummary;
                        const summaryLc = rawSummary.length
                          ? `${rawSummary.charAt(0).toLowerCase()}${rawSummary.slice(1)}`
                          : rawSummary;
                        const pct = weatherBrief.todayRainChancePct;
                        const mm = weatherBrief.todayRainMm;
                        const ariaRain =
                          pct != null && pct >= 20
                            ? ` About ${Math.round(pct)} percent chance of rain.`
                            : mm >= 0.4
                              ? ` Roughly ${mm.toFixed(1)} millimeters rain expected.`
                              : "";
                        const ariaLabel = `Right now ${t} degrees Celsius, ${rawSummary}. Today around ${lo} to ${hi} degrees.${ariaRain}`;
                        let rangeSuffix: ReactNode = ".";
                        if (pct != null && pct >= 20) {
                          rangeSuffix = (
                            <>
                              , with about a <strong>{Math.round(pct)}%</strong> chance of rain.
                            </>
                          );
                        } else if (mm >= 0.4) {
                          rangeSuffix = (
                            <>
                              , expecting roughly <strong>{mm.toFixed(1)} mm</strong> rain.
                            </>
                          );
                        }
                        return (
                          <p className="regional-forecast-blurb" aria-label={ariaLabel}>
                            {"It's "}
                            <strong>{t}°</strong>
                            {" "}
                            and {summaryLc}. Today around{" "}
                            <strong>{lo}°–{hi}°</strong>
                            {rangeSuffix}
                          </p>
                        );
                      })()}
                      {(() => {
                        const tip =
                          weatherBrief.alerts.find((a) => a.kind === "rain") ??
                          weatherBrief.alerts.find((a) => a.kind === "heat");
                        return tip ? (
                          <p className={`weather-alert weather-alert--${tip.kind}`} role="status">
                            {tip.text}
                          </p>
                        ) : null;
                      })()}
                      <p className="muted weather-updated-foot">
                        Last updated{" "}
                        {(() => {
                          const t = parseISO(weatherBrief.fetchedAt);
                          return Number.isFinite(+t)
                            ? formatDistanceToNow(t, { addSuffix: true })
                            : "recently";
                        })()}
                      </p>
                    </>
                  )}
                </div>

                <div className="regional-brief-panel regional-brief-panel--news">
                  <div className="regional-panel-head">
                    <span className="regional-panel-kicker">Recent on X</span>
                  </div>
                  {!newsLoading && newsItems.length === 0 && !newsError && (
                    <p className="muted">Tap Refresh for recent Somaliland posts.</p>
                  )}
                  {newsLoading && newsItems.length === 0 && (
                    <p className="muted">Loading…</p>
                  )}
                  {!newsLoading && newsError && (
                    <p className="muted">{newsError}</p>
                  )}
                  {!newsLoading && !newsError && recentNewsItems.length > 0 && (
                    <div className="news-feed-list">
                      {recentNewsItems.slice(0, 4).map((item) => (
                        <button
                          key={item.url}
                          type="button"
                          className="news-feed-item regional-news-hit"
                          onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}
                        >
                          <div className="news-feed-meta">
                            <span className="news-feed-source">{item.source}</span>
                            <span className="muted">
                              {item.publishedAt
                                ? `${formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true })}`
                                : "Recent"}
                            </span>
                          </div>
                          <strong className="news-feed-title">{item.title}</strong>
                          <p className="muted news-feed-description">{item.description}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                </div>
              </div>
            </section>
            <section className="home-intro live-briefing-grid">
              {liveOverview}
            </section>

            <div className="home-section-head">
              <h3>Coach memory</h3>
              <p className="muted">Learns your real money habits</p>
            </div>
            <section className="card coach-memory-card">
              {coachMemoryHighlights.length > 0 ? (
                <>
                  {coachMemoryHighlights.map((memory) => (
                    <article key={memory.kind} className="coach-memory-item">
                      <div className="coach-memory-head">
                        <div>
                          <p className="coach-memory-kicker">{memory.title}</p>
                          <strong>{memory.summary}</strong>
                        </div>
                        <span className="coach-memory-confidence">{memory.confidence}% match</span>
                      </div>
                      <div className="coach-memory-evidence">
                        {memory.evidence.slice(0, 2).map((line) => (
                          <p key={line} className="muted">- {line}</p>
                        ))}
                      </div>
                    </article>
                  ))}
                </>
              ) : (
                <p className="muted">Add a bit more transaction history and Coach Zero will start remembering your spending rhythm automatically.</p>
              )}
            </section>

            <section className="card daily-context-note-card">
              <div className="daily-context-note-top">
                <div className="daily-context-note-top-copy">
                  <p className="daily-context-note-kicker">Daily memory</p>
                  <h3>Today note</h3>
                  <p className="muted">{todayNotePreview}</p>
                </div>
                <div className="daily-context-note-top-actions">
                  <span className="badge">{dailyContextNotes.length} note{dailyContextNotes.length === 1 ? "" : "s"}</span>
                  <button
                    type="button"
                    className="daily-context-note-collapse-btn"
                    aria-expanded={todayNoteExpanded}
                    aria-label={todayNoteExpanded ? "Collapse Today note" : "Expand Today note"}
                    onClick={() => setTodayNoteExpanded((v) => !v)}
                  >
                    <span className="regional-brief-chevron" />
                  </button>
                </div>
              </div>
              <div className={`daily-context-note-panel ${todayNoteExpanded ? "is-expanded" : "is-collapsed"}`} aria-hidden={!todayNoteExpanded}>
                <div className="daily-context-note-summary">
                  <div className="daily-context-note-summary-copy">
                    <p className="daily-context-note-date">{format(parseISO(todayIso), "EEEE, MMM d")}</p>
                    <strong>{todayContextNote?.title?.trim() || "Capture what happened, why it mattered, and what to remember next."}</strong>
                    <p className="muted">Add spending, plans, subscriptions, or routine context if it matters today.</p>
                  </div>
                  <div className="daily-context-note-summary-pills">
                    <span className={`daily-context-note-ai-pill ${dailyContextNoteDraft.aiVisible ? "on" : "off"}`}>
                      {dailyContextNoteDraft.aiVisible ? "AI on" : "Private"}
                    </span>
                    <span className="badge">{recentAiVisibleNotes.length} AI-visible</span>
                  </div>
                </div>

                <div className="daily-context-note-compose">
                  <div className="daily-context-note-example">
                    <span className="daily-context-note-example-label">Example</span>
                    <p className="muted">Ate out because I missed meal prep, spent more than planned, need to prep lunch tonight.</p>
                  </div>
                  <div className="daily-context-note-grid">
                    <label>
                      Title
                      <input
                        value={dailyContextNoteDraft.title}
                        onChange={(e) => {
                          const value = e.target.value;
                          setDailyContextNoteDraft((prev) => ({ ...prev, title: value }));
                          setDailyContextNoteStatus("");
                        }}
                        placeholder="Optional title"
                        maxLength={120}
                      />
                    </label>
                    <label>
                      Tags
                      <input
                        value={dailyContextNoteDraft.tags}
                        onChange={(e) => {
                          const value = e.target.value;
                          setDailyContextNoteDraft((prev) => ({ ...prev, tags: value }));
                          setDailyContextNoteStatus("");
                        }}
                        placeholder="spending, subscriptions, routine"
                      />
                    </label>
                  </div>
                  <label className="daily-context-note-field-body">
                    Quick note
                    <textarea
                      rows={5}
                      value={dailyContextNoteDraft.body}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDailyContextNoteDraft((prev) => ({ ...prev, body: value }));
                        setDailyContextNoteStatus("");
                      }}
                      placeholder="What happened today, why it happened, and what should you remember next?"
                      maxLength={1200}
                    />
                  </label>
                  <label className="daily-context-note-toggle">
                    <input
                      type="checkbox"
                      checked={dailyContextNoteDraft.aiVisible}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setDailyContextNoteDraft((prev) => ({ ...prev, aiVisible: checked }));
                        setDailyContextNoteStatus("");
                      }}
                    />
                    <span>Let AI use this note later for smarter help</span>
                  </label>
                  <div className="daily-context-note-actions">
                    <button type="button" onClick={() => { void saveDailyContextNote(); }}>
                      Save note
                    </button>
                    <button type="button" className="ghost-btn" onClick={() => { void clearDailyContextNote(); }}>
                      Clear
                    </button>
                  </div>
                  <div className="daily-context-note-footer">
                    <span className="muted">
                      {dailyContextNoteStatus
                        || (todayContextNote
                          ? `Last saved ${formatDistanceToNow(new Date(todayContextNote.updatedAt), { addSuffix: true })}`
                          : "No note saved yet")}
                    </span>
                  </div>
                </div>

                <div className="daily-context-note-history">
                  <div className="daily-context-note-history-head">
                    <div>
                      <p className="daily-context-note-kicker">Recent notes</p>
                      <strong>Your notes</strong>
                    </div>
                    <span className="badge">{dailyContextNotes.length}</span>
                  </div>
                  {recentDailyContextNotes.length > 0 ? (
                    <div className="daily-context-note-history-list">
                      {recentDailyContextNotes.map((note) => (
                        <article
                          key={note.id ?? `${note.date}-${note.updatedAt}`}
                          className={`daily-context-note-item${note.date === todayIso ? " is-today" : ""}`}
                        >
                          <div className="daily-context-note-item-head">
                            <div>
                              <strong>{note.title.trim() || format(parseISO(note.date), "EEE, MMM d")}</strong>
                              <p className="muted">
                                {format(parseISO(note.date), "EEE, MMM d")}
                                {note.aiVisible ? " · AI visible" : " · Private"}
                              </p>
                            </div>
                            {note.date === todayIso && <span className="badge">Today</span>}
                          </div>
                          {note.tags.length > 0 && (
                            <div className="daily-context-note-tags">
                              {note.tags.slice(0, 4).map((tag) => <span key={`${note.date}-${tag}`}>{tag}</span>)}
                            </div>
                          )}
                          <p className="daily-context-note-item-body">{note.body || "No details added."}</p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No notes yet. Save one here and it will show up in your history.</p>
                  )}
                </div>
              </div>
            </section>

            <div className="home-section-head">
              <h3>Top numbers</h3>
              <p className="muted">Updated with every transaction</p>
            </div>
            <motion.section
              className="card main-card finance-card finance-card-weekly"
              whileHover={{ y: -4, scale: 1.01, rotateX: 1.4, rotateY: -1.4 }}
              whileTap={{ scale: 0.985, y: -1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
            >
              <div className="credit-card-top">
                <p className="muted">Weekly Safe to Use</p>
                <span className="card-network">ZERO</span>
              </div>
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
              <p className="muted finance-card-note">{showWeeklySafe ? "Tap amount to hide" : "Tap amount to reveal"}</p>
              <div className="credit-card-bottom">
                <span>Weekly limit</span>
                <span>{budgetSnapshot.daysLeftInWeek}d left</span>
              </div>
            </motion.section>
            <motion.section
              className="credit-card finance-card finance-card-monthly"
              whileHover={{ y: -4, scale: 1.01, rotateX: 1.2, rotateY: 1.2 }}
              whileTap={{ scale: 0.985, y: -1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
            >
              <div className="credit-card-top">
                <p className="muted">Zero Card</p>
                <span className="chip" aria-hidden="true" />
              </div>
              <div className="credit-card-balance-row">
                <p className="credit-card-balance-label">Monthly real balance</p>
                <button
                  type="button"
                  className="credit-card-edit-btn"
                  onClick={() => {
                    setEditingMonthlyReal((v) => !v);
                    setShowMonthlyBalance(true);
                  }}
                >
                  {editingMonthlyReal ? "Close" : "Edit"}
                </button>
              </div>
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
              {editingMonthlyReal && (
                <form
                  className="credit-card-edit-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const desiredMonthlyReal = Number(monthlyRealDraft);
                    if (!Number.isFinite(desiredMonthlyReal)) return;
                    const targetCurrentBalance = desiredMonthlyReal + budgetSnapshot.remainingMonthSubscriptions;
                    void updateSettings({ currentBalance: Number(targetCurrentBalance.toFixed(2)) });
                    setEditingMonthlyReal(false);
                  }}
                >
                  <input
                    type="number"
                    step="0.01"
                    value={monthlyRealDraft}
                    onChange={(e) => setMonthlyRealDraft(e.target.value)}
                    placeholder="Set monthly real balance"
                  />
                  <button type="submit">Save</button>
                </form>
              )}
              <p className="muted finance-card-note">{showMonthlyBalance ? "Tap amount to hide" : "Tap amount to reveal"}</p>
              <div className="credit-card-bottom">
                <span>Cash-based</span>
                <span>{budgetSnapshot.daysLeftInMonth}d left</span>
              </div>
            </motion.section>

            <div className="home-section-head">
              <h3>Daily allowance</h3>
              <p className="muted">Simple, focused, actionable</p>
            </div>
            <section className="card daily-goal-card">
              <article className="card daily-allowance-main">
                <div className="metric-label-row">
                  <p className="muted">Money left today</p>
                  <button
                    type="button"
                    className="why-pill-btn"
                    onClick={() => toggleMoneyExplanation("daily_safe_to_spend")}
                  >
                    Why?
                  </button>
                </div>
                <h3>{money(Math.max(0, todayRemaining))}</h3>
                <p className="muted">of {money(safePerDay)} daily allowance</p>
                <div className="daily-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={allowanceProgressPct}>
                  <div className={`daily-progress-fill ${allowanceProgressTone}`} style={{ width: `${allowanceProgressPct}%` }} />
                </div>
              </article>
              {activeMoneyExplanationCard?.id === "daily_safe_to_spend" ? (
                <MoneyExplanationCard explanation={activeMoneyExplanationCard} />
              ) : null}
              <article className="card daily-allowance-status">
                <p>{dailyAllowanceStatusText}</p>
              </article>
              <article className="card daily-allowance-plan">
                <button type="button" className="daily-allowance-collapse" onClick={() => setShowAllowancePlanDetails((v) => !v)}>
                  <span className="muted">Save {money(savePlan.savePerDay)}/day {"->"} {money(savePlan.inThreeDays)} buffer in 3 days</span>
                  <span className="muted">{showAllowancePlanDetails ? "Hide" : "Expand"}</span>
                </button>
                {showAllowancePlanDetails && (
                  <div className="daily-allowance-plan-details">
                    <p className="muted">Day 1-3 save target: {money(savePlan.savePerDay)} each day.</p>
                    <p className="muted">Total extra buffer after 3 days: {money(savePlan.inThreeDays)}.</p>
                    <p className="muted">{smartSavingsTip}</p>
                  </div>
                )}
              </article>
              {weeklyUpcomingSubs > 0 && weeklyDueBills.length > 0 && (
                <article className="card daily-allowance-bills">
                  <button type="button" className="daily-allowance-collapse" onClick={() => setShowAllowanceBillsDetails((v) => !v)}>
                    <span>⚠ {money(weeklyUpcomingSubs)} due this week</span>
                    <span className="muted">{showAllowanceBillsDetails ? "Hide bills" : "Tap to see which bills"}</span>
                  </button>
                  {showAllowanceBillsDetails && (
                    <div className="daily-allowance-bills-details">
                      {weeklyDueBills.map((bill) => (
                        <div key={bill.id} className="daily-allowance-bill-row">
                          <span>
                            {bill.name} - {money(bill.amount)} ({format(parseISO(bill.dueDate), "EEE d MMM")})
                          </span>
                          {bill.id != null && (
                            <button type="button" className="ghost-btn" onClick={() => setMarkPaidTarget(bill)}>
                              Paid
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              )}
            </section>
            <section className="card cashflow-outlook-card" aria-labelledby="cashflow-outlook-heading">
              <div className="row regional-brief-top">
                <div className="regional-brief-title-row">
                  <button
                    type="button"
                    className="regional-brief-collapse-btn"
                    aria-expanded={cashflowOutlookExpanded}
                    aria-controls="cashflow-outlook-body"
                    aria-label={cashflowOutlookExpanded ? "Collapse Cashflow outlook" : "Expand Cashflow outlook"}
                    onClick={() => setCashflowOutlookExpanded((v) => !v)}
                  >
                    <span className="regional-brief-chevron" aria-hidden />
                  </button>
                  <div className="regional-brief-title-copy">
                    <h3 id="cashflow-outlook-heading" className="regional-brief-title-plain">
                      Cashflow outlook
                    </h3>
                    <p className="muted">Next 30 days</p>
                  </div>
                </div>
              </div>
              <div
                id="cashflow-outlook-body"
                className={`cashflow-outlook-body ${cashflowOutlookExpanded ? "is-expanded" : "is-collapsed"}`}
                aria-hidden={!cashflowOutlookExpanded}
              >
              {cashflowForecast ? (
                <>
                  <div className="cashflow-outlook-head">
                    <div className="cashflow-outlook-copy">
                      <p className="cashflow-kicker">Forecast 2.0</p>
                      <div className="metric-value-row">
                        <strong className={`cashflow-hero-amount ${cashflowForecast.lowestPoint && cashflowForecast.lowestPoint.balance < 0 ? "negative" : ""}`}>
                          {money(cashflowForecast.lowestPoint?.balance ?? realBalance)}
                        </strong>
                        <button
                          type="button"
                          className="why-pill-btn"
                          onClick={() => toggleMoneyExplanation("cashflow_lowest_point")}
                        >
                          Why?
                        </button>
                      </div>
                      <p className="muted cashflow-hero-caption">
                        {cashflowForecast.lowestPoint
                          ? `Lowest likely balance by ${format(parseISO(cashflowForecast.lowestPoint.date), "EEE, MMM d")}`
                          : "No projection yet"}
                      </p>
                    </div>
                    <span className={`cashflow-status-pill ${cashflowForecast.requiredCorrection ? "is-risk" : "is-safe"}`}>
                      {cashflowForecast.requiredCorrection ? "Needs correction" : "Stable"}
                    </span>
                  </div>
                  {activeMoneyExplanationCard?.id === "cashflow_lowest_point" ? (
                    <MoneyExplanationCard explanation={activeMoneyExplanationCard} />
                  ) : null}

                  <div className="cashflow-stat-grid">
                    <article className="cashflow-stat-card">
                      <p className="cashflow-stat-label">After subs</p>
                      <strong>{money(cashflowForecast.salaryContext.salaryAfterSubscriptions)}</strong>
                      <p className="muted">From {money(cashflowForecast.salaryContext.monthlySalary)} salary base per month.</p>
                    </article>
                    <article className="cashflow-stat-card">
                      <p className="cashflow-stat-label">Monthly runway</p>
                      <strong className={cashflowForecast.salaryContext.monthlyNetAfterTransactions < 0 ? "negative" : ""}>
                        {money(cashflowForecast.salaryContext.monthlyNetAfterTransactions)}
                      </strong>
                      <p className="muted">{money(cashflowForecast.salaryContext.monthlyObservedSpend)} observed spend after fixed costs.</p>
                    </article>
                    <article className="cashflow-stat-card cashflow-stat-card--wide">
                      <p className="cashflow-stat-label">Buffer</p>
                      <strong>{money(cashflowForecast.threshold)}</strong>
                      <p className="muted">
                        {cashflowForecast.nextRiskDay
                          ? `First likely risk ${format(parseISO(cashflowForecast.nextRiskDay.date), "MMM d")}`
                          : "No likely day below floor right now"}
                      </p>
                    </article>
                  </div>

                  <div className="cashflow-spend-grid">
                    <article className="cashflow-spend-card">
                      <p className="cashflow-stat-label">Essential pace</p>
                      <strong>{money(cashflowForecast.salaryContext.monthlyEssentialSpend)}</strong>
                      <p className="muted">Observed from recurring/essential transaction categories.</p>
                    </article>
                    <article className="cashflow-spend-card">
                      <p className="cashflow-stat-label">Flexible pace</p>
                      <strong>{money(cashflowForecast.salaryContext.monthlyFlexibleSpend)}</strong>
                      <p className="muted">Observed from food, shopping, eating out, and other adjustable spend.</p>
                    </article>
                  </div>

                  {cashflowForecast.requiredCorrection ? (
                    <div className="cashflow-correction-callout" role="status">
                      <strong>Required correction</strong>
                      <p className="muted">
                        To stay above your buffer, reduce flexible spending by{" "}
                        <strong>{money(cashflowForecast.requiredCorrection.amountPerDay)}/day</strong> for the next{" "}
                        <strong>{cashflowForecast.requiredCorrection.days}</strong> day(s), through{" "}
                        <strong>{format(parseISO(cashflowForecast.requiredCorrection.targetDate), "MMM d")}</strong>.
                      </p>
                    </div>
                  ) : (
                    <p className="muted cashflow-no-risk">Likely path stays above your {money(cashflowForecast.threshold)} buffer right now.</p>
                  )}

                  <div className="cashflow-section">
                    <p className="cashflow-subtitle">Key checkpoints</p>
                    <div className="cashflow-checkpoint-grid">
                      {[cashflowForecast.checkpoints.nextPayday, cashflowForecast.checkpoints.monthEnd].filter(Boolean).map((checkpoint) => (
                        <article key={checkpoint!.label} className="cashflow-checkpoint-card">
                          <p className="cashflow-subtitle">{checkpoint!.label}</p>
                          <p className="muted">
                            {cashflowForecast.nextPayday && checkpoint!.label === cashflowForecast.nextPayday.label
                              ? `${format(parseISO(checkpoint!.date), "EEEE, MMM d")} · ${cashflowForecast.nextPayday.label}`
                              : format(parseISO(checkpoint!.date), "EEEE, MMM d")}
                          </p>
                          <div className="cashflow-scenario-row">
                            <span>Best</span>
                            <strong className="positive">{money(checkpoint!.bestBalance)}</strong>
                          </div>
                          <div className="cashflow-scenario-row">
                            <span>Likely</span>
                            <strong className={checkpoint!.likelyBalance < 0 ? "negative" : ""}>{money(checkpoint!.likelyBalance)}</strong>
                          </div>
                          <div className="cashflow-scenario-row">
                            <span>Worst</span>
                            <strong className={checkpoint!.worstBalance < 0 ? "negative" : ""}>{money(checkpoint!.worstBalance)}</strong>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>

                  <div className="cashflow-section">
                    <p className="cashflow-subtitle">8-day path</p>
                    <div className="cashflow-mini-days" aria-label="Projected balance by day">
                      {cashflowForecast.points.slice(0, 8).map((point) => (
                        <article key={point.date} className={`cashflow-mini-day ${point.belowThreshold ? "is-risk" : ""}`}>
                          <span className="cashflow-mini-day-label">{format(parseISO(point.date), "EEE")}</span>
                          <strong className={point.balance < 0 ? "negative" : ""}>{money(point.balance)}</strong>
                          <span className="muted cashflow-mini-range">
                            {money(point.bestBalance)} to {money(point.worstBalance)}
                          </span>
                        </article>
                      ))}
                    </div>
                  </div>

                  {cashflowForecast.categoryTrends.length > 0 ? (
                    <div className="cashflow-trend-list">
                      <p className="cashflow-subtitle">Category trends</p>
                      {cashflowForecast.categoryTrends.slice(0, 4).map((trend) => (
                        <div key={trend.category} className="cashflow-trend-item">
                          <div>
                            <strong>{trend.category}</strong>
                            <p className="muted">
                              {trend.spendClass === "essential" ? "Essential" : "Flexible"} · last 30 days {money(trend.recent30Total)}
                            </p>
                          </div>
                          <strong className={trend.direction === "rising" ? "negative" : trend.direction === "falling" ? "positive" : ""}>
                            {trend.direction === "rising" ? "Rising" : trend.direction === "falling" ? "Falling" : "Stable"}
                            {" "}
                            ({trend.changePct > 0 ? "+" : ""}{trend.changePct.toFixed(0)}%)
                          </strong>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {forecastRiskPreview.length > 0 ? (
                    <div className="cashflow-risk-list">
                      <p className="cashflow-subtitle">Likely risk days</p>
                      {forecastRiskPreview.map((point) => (
                        <div key={point.date} className="cashflow-risk-item">
                          <div>
                            <strong>{format(parseISO(point.date), "EEEE, MMM d")}</strong>
                            <p className="muted">
                              {point.events.length > 0
                                ? point.events
                                  .filter((event) => event.kind !== "baseline_spend")
                                  .slice(0, 2)
                                  .map((event) => event.label)
                                  .join(" · ") || "Daily spending pace"
                                : "Daily spending pace"}
                            </p>
                          </div>
                          <strong className="negative">{money(point.balance)}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {forecastEventPreview.length > 0 ? (
                    <div className="cashflow-event-list">
                      <p className="cashflow-subtitle">Upcoming scheduled hits</p>
                      {forecastEventPreview.map((event, idx) => (
                        <div key={`${event.date}-${event.label}-${idx}`} className="cashflow-event-item">
                          <div>
                            <strong>{event.label}</strong>
                            <p className="muted">{format(parseISO(event.date), "EEE, MMM d")}</p>
                          </div>
                          <strong className={event.amount >= 0 ? "positive" : "negative"}>{money(event.amount)}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {cashflowForecast.irregularExpenses.length > 0 ? (
                    <div className="cashflow-event-list">
                      <p className="cashflow-subtitle">Irregular big expenses</p>
                      {cashflowForecast.irregularExpenses.map((expense, idx) => (
                        <div key={`${expense.date}-${expense.label}-${idx}`} className="cashflow-event-item">
                          <div>
                            <strong>{expense.label}</strong>
                            <p className="muted">{expense.category} · {format(parseISO(expense.date), "EEE, MMM d")}</p>
                          </div>
                          <strong className="negative">{money(expense.amount)}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="muted">Set your balance first, then add paydays or planned cash items in Settings to build the projection.</p>
              )}
              </div>
            </section>

            <div className="home-section-head">
              <h3>Recent activity</h3>
              <p className="muted">Swipe to edit or delete</p>
            </div>
            <section className="card recent-transactions-card">
              <div className="recent-tx-head">
                <div>
                  <h3>Recent transactions</h3>
                  <p className="muted recent-tx-subline">
                    Spent {money(recentTransactionSummary.expense)} · Added {money(recentTransactionSummary.income)}
                  </p>
                </div>
                <p className="recent-tx-count">{recentTransactionSummary.count} items</p>
              </div>
              <div className="recent-tx-list">
                {recentTransactions.length > 0 ? (
                  recentTransactions.map((t) => (
                    <TransactionRow key={t.id} tx={t} onDelete={() => deleteTransaction(t.id!)} onEdit={() => { setEditingTx(t); setShowTx(true); }} />
                  ))
                ) : (
                  <div className="recent-tx-empty">
                    <strong>No transactions yet</strong>
                    <p className="muted">Add your first entry to start tracking your real daily pace.</p>
                  </div>
                )}
              </div>
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
            {subscriptionSuggestions.length > 0 && (
              <div className="subscription-suggestions">
                <div className="subscription-suggestions-head">
                  <strong>Suggestions from transactions</strong>
                  <span className="muted">Auto-detected recurring charges</span>
                </div>
                {subscriptionSuggestions.slice(0, 4).map((candidate) => (
                  <article key={candidate.signature} className="subscription-suggestion-card">
                    <div className="subscription-suggestion-copy">
                      <p className="subscription-suggestion-kicker">
                        Looks like a {candidate.cycle} subscription
                      </p>
                      <strong>{candidate.name}</strong>
                      <p className="muted">
                        {money(candidate.amount)} · confidence {candidate.confidence}% · seen {candidate.matchCount} time{candidate.matchCount === 1 ? "" : "s"}
                      </p>
                      <p className="muted">{candidate.hint}</p>
                    </div>
                    <div className="inline-actions">
                      <button type="button" onClick={() => { void addDetectedSubscription(candidate); }}>
                        Add
                      </button>
                      <button type="button" className="ghost-btn" onClick={() => dismissSubscriptionSuggestion(candidate.signature)}>
                        Dismiss
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {upcoming.length > 0 ? upcoming.map((s) => (
              <SubscriptionRow
                key={s.id}
                row={s}
                onEdit={() => {
                  setEditingSub(subscriptions.find((x) => x.id === s.id) ?? null);
                  setShowSub(true);
                }}
                onMarkPaid={() => setMarkPaidTarget(subscriptions.find((x) => x.id === s.id) ?? s)}
              />
            )) : (
              <p className="muted">
                {subscriptionSuggestions.length > 0
                  ? "No saved subscriptions yet. Start by accepting one of the suggestions above or add one manually."
                  : "No subscriptions yet. Add one manually, or log a repeating charge a couple of times and I’ll suggest it here."}
              </p>
            )}
          </section>
        )}

        {tab === "Insights" && (
          <div className="routine-layout routine-ios">
            <section className="card routine-card routine-card-now">
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
                    <h3>Nothing scheduled right now</h3>
                    <p className="muted">Drop in one focus block so this hour has a clear target.</p>
                  </div>
                  <button type="button" onClick={() => {
                    const now = new Date();
                    const raw = now.getHours() * 60 + now.getMinutes();
                    const snapped = Math.round(raw / 15) * 15;
                    const capped = Math.min(snapped, 24 * 60 - 60);
                    setEditingTimelineEvent({
                      id: Date.now(),
                      title: "",
                      hour: Math.floor(capped / 60),
                      startMinute: capped % 60,
                      category: "work",
                      durationMinutes: 60,
                      date: format(new Date(), "yyyy-MM-dd"),
                    });
                    setShowTimelineSheet(true);
                  }}>+ Add</button>
                </div>
              )}
            </section>

            <section className="card routine-card routine-card-timeline routine-card-timeline-ios">
              <p className="routine-section-kicker">TIMELINE</p>
              <IosDayTimeline
                events={timelineEvents}
                liveNow={liveNow}
                todayKey={format(liveNow, "yyyy-MM-dd")}
                onEditEvent={(ev) => {
                  const tk = format(liveNow, "yyyy-MM-dd");
                  setEditingTimelineEvent({
                    id: ev.id,
                    title: ev.title,
                    hour: ev.hour,
                    startMinute: ev.startMinute,
                    durationMinutes: ev.durationMinutes ?? 60,
                    category: ev.category,
                    subtasks: ev.subtasks,
                    date: ev.date ?? tk,
                  });
                  setShowTimelineSheet(true);
                }}
                onAddAtMinuteOfDay={(dateKey, minuteOfDay) => {
                  const snapped = Math.round(Math.max(5 * 60, Math.min(24 * 60 - 15, minuteOfDay)) / 15) * 15;
                  setEditingTimelineEvent({
                    id: Date.now(),
                    title: "",
                    hour: Math.floor(snapped / 60),
                    startMinute: snapped % 60,
                    category: "work",
                    durationMinutes: 60,
                    date: dateKey,
                  });
                  setShowTimelineSheet(true);
                }}
              />
            </section>

            <section className="card routine-card routine-card-checklist checklist-board">
              <p className="routine-section-kicker">DAILY CHECKLIST</p>
              <div className="checklist-board-head">
                <div>
                  <h3>Today&apos;s focus</h3>
                  <p className="muted checklist-board-lede">
                    A short list beats a long one — capture priorities and clear them in order. Done items disappear on the next calendar day; open items carry forward.
                  </p>
                </div>
                <div className="checklist-board-stat" aria-live="polite">
                  <span className="checklist-board-stat-value">{checklistProgressPct}%</span>
                  <span className="muted checklist-board-stat-caption">{doneTasks}/{tasks.length || 0}</span>
                </div>
              </div>
              <div className="routine-progress-track checklist-board-meter" role="progressbar" aria-valuenow={checklistProgressPct} aria-valuemin={0} aria-valuemax={100} aria-label="Checklist completion">
                <div className="routine-progress-fill" style={{ width: `${checklistProgressPct}%` }} />
              </div>

              <form
                className="checklist-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  const title = checklistDraft.title.trim();
                  if (!title) return;
                  setTasks((prev) => [
                    ...prev,
                    {
                      id: Date.now(),
                      title,
                      priority: checklistDraft.priority,
                      category: checklistDraft.category,
                      done: false,
                    },
                  ]);
                  setChecklistDraft((d) => ({ ...d, title: "" }));
                }}
              >
                <label className="checklist-composer-field">
                  <span className="muted checklist-composer-label">New task</span>
                  <input
                    value={checklistDraft.title}
                    onChange={(e) => setChecklistDraft((d) => ({ ...d, title: e.target.value }))}
                    placeholder="e.g. Deep work · Reply invoices · Walk"
                    autoComplete="off"
                  />
                </label>
                <div className="checklist-composer-pickers">
                  <div className="checklist-picker-group">
                    <span className="muted checklist-picker-heading">Priority</span>
                    <div className="task-filter-row checklist-segment">
                      {(["high", "medium", "low"] as const).map((p) => (
                        <button
                          key={p}
                          type="button"
                          className={checklistDraft.priority === p ? "active" : ""}
                          onClick={() => setChecklistDraft((d) => ({ ...d, priority: p }))}
                        >
                          {p === "high" ? "High" : p === "medium" ? "Med" : "Low"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="checklist-picker-group">
                    <span className="muted checklist-picker-heading">Area</span>
                    <div className="task-filter-row checklist-segment">
                      {(["work", "health", "personal"] as const).map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={checklistDraft.category === c ? "active" : ""}
                          onClick={() => setChecklistDraft((d) => ({ ...d, category: c }))}
                        >
                          {c[0].toUpperCase() + c.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <button type="submit" className="checklist-composer-submit">
                  Add to checklist
                </button>
              </form>

              {tasks.length === 0 && (
                <div className="routine-empty checklist-board-empty">
                  <p><strong>Nothing listed yet</strong></p>
                  <p className="muted">Add one must-do above, or ask Coach Zero for suggestions from the assistant panel.</p>
                </div>
              )}

              {openChecklistTasks.length > 0 && (
                <div className="checklist-board-section">
                  <p className="checklist-board-section-title">Up next</p>
                  <ul className="checklist-board-list">
                    {openChecklistTasks.map((task) => (
                      <li key={task.id} className={`checklist-board-item checklist-board-item--${task.category}`}>
                        <button
                          type="button"
                          className="checklist-board-check"
                          aria-checked={false}
                          role="checkbox"
                          aria-label={`Mark complete: ${task.title}`}
                          onClick={() =>
                            setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done: true } : t)))
                          }
                        />
                        <div className="checklist-board-item-body">
                          <span className="checklist-board-item-title">{task.title}</span>
                          <div className="checklist-board-item-meta">
                            <span className={`task-meta ${task.priority}`}>{task.priority}</span>
                            <span className="checklist-board-cat">{task.category}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="ghost-btn checklist-board-remove"
                          aria-label={`Remove task: ${task.title}`}
                          onClick={() => setTasks((prev) => prev.filter((t) => t.id !== task.id))}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {doneChecklistTasks.length > 0 && (
                <div className="checklist-board-section checklist-board-section--done">
                  <p className="checklist-board-section-title muted">Completed</p>
                  <ul className="checklist-board-list">
                    {doneChecklistTasks.map((task) => (
                      <li key={task.id} className={`checklist-board-item checklist-board-item--done checklist-board-item--${task.category}`}>
                        <button
                          type="button"
                          className="checklist-board-check checklist-board-check--done"
                          aria-checked={true}
                          role="checkbox"
                          aria-label={`Mark incomplete: ${task.title}`}
                          onClick={() =>
                            setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done: false } : t)))
                          }
                        >
                          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M6 12.5 10 16.5 18 8.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                        <div className="checklist-board-item-body">
                          <span className="checklist-board-item-title checklist-board-item-title--done">{task.title}</span>
                          <div className="checklist-board-item-meta">
                            <span className={`task-meta ${task.priority}`}>{task.priority}</span>
                            <span className="checklist-board-cat">{task.category}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="ghost-btn checklist-board-remove"
                          aria-label={`Remove task: ${task.title}`}
                          onClick={() => setTasks((prev) => prev.filter((t) => t.id !== task.id))}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {tasks.length > 0 && doneTasks === tasks.length && (
                <div className="routine-celebration checklist-board-celebration">
                  <h4>Checklist clear</h4>
                  <p>You closed every item today — carry that momentum into tomorrow&apos;s first block.</p>
                </div>
              )}
            </section>

            <section className="card routine-card routine-card-template">
              <p className="routine-section-kicker">ROUTINE TEMPLATE</p>
              <div className="row routine-card-head">
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

            <section className="card routine-card routine-card-plan">
              <p className="routine-section-kicker">PLAN AHEAD</p>
              <div className="row routine-card-head">
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

            <section className="card routine-card routine-card-reminders">
              <p className="routine-section-kicker">REMINDERS</p>
              {routineReminders.map((item) => (
                <article key={item.id} className="routine-reminder-item">
                  <div className="routine-reminder-left">
                    <span className="routine-reminder-icon">🔔</span>
                    <div>
                      <h3>{item.label}</h3>
                      <p className="muted">
                        {item.mode === "clock" && item.clockTime
                          ? `At ${item.clockTime}`
                          : `Remind me in ${Math.max(1, Math.round(item.delaySeconds / 60))} min`}
                      </p>
                      {item.message?.trim() && <p className="muted">{item.message}</p>}
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
              <button type="button" className="routine-add-reminder" onClick={() => { setEditingRoutineReminder({ id: Date.now(), label: "Routine reminder", message: "Time to review your routine.", mode: "in", delaySeconds: 1800, clockTime: "08:00", enabled: true }); setShowRoutineReminderSheet(true); }}>
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
                <label>Risk threshold<input type="number" value={settings.forecastRiskThreshold ?? settings.reservedSavings ?? 0} onChange={(e) => updateSettings({ forecastRiskThreshold: Number(e.target.value) })} /></label>
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
              <p className="settings-kicker">Forecast setup</p>
              <h3>Recurring income</h3>
              <p className="muted">Add the next payday for each income stream so the projection can place cash on the right days.</p>
              <div className="cashflow-inline-form">
                <label>Name<input value={incomeDraft.name} onChange={(e) => setIncomeDraft((prev) => ({ ...prev, name: e.target.value }))} placeholder="Salary" /></label>
                <label>Amount<input type="number" value={incomeDraft.amount} onChange={(e) => setIncomeDraft((prev) => ({ ...prev, amount: e.target.value }))} placeholder="0" /></label>
                <label>Cycle<select value={incomeDraft.cycle} onChange={(e) => setIncomeDraft((prev) => ({ ...prev, cycle: e.target.value as RecurringIncomeCycle }))}><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option></select></label>
                <label>Next payday<input type="date" value={incomeDraft.nextDate} onChange={(e) => setIncomeDraft((prev) => ({ ...prev, nextDate: e.target.value }))} /></label>
              </div>
              {incomeDraftError ? <p className="error-text">{incomeDraftError}</p> : null}
              <div className="settings-actions">
                <button type="button" onClick={() => { void saveIncomeDraft(); }}>{incomeDraft.id ? "Update income" : "Add income"}</button>
                {incomeDraft.id ? <button type="button" className="ghost-btn" onClick={resetIncomeDraft}>Cancel edit</button> : null}
              </div>
              <div className="cashflow-settings-list">
                {recurringIncome.length === 0 ? (
                  <p className="muted">No recurring income yet. Add your next paycheck or other repeating income above.</p>
                ) : (
                  recurringIncome.map((row) => (
                    <div key={row.id} className="cashflow-settings-item">
                      <div>
                        <strong>{row.name}</strong>
                        <p className="muted">{money(row.amount)} · {row.cycle} · {format(parseISO(row.nextDate), "MMM d, yyyy")}</p>
                      </div>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => {
                            setIncomeDraft({
                              id: row.id ?? null,
                              name: row.name,
                              amount: String(row.amount),
                              cycle: row.cycle,
                              nextDate: format(parseISO(row.nextDate), "yyyy-MM-dd"),
                            });
                            setIncomeDraftError("");
                          }}
                        >
                          Edit
                        </button>
                        <button type="button" className="ghost-btn" onClick={() => { if (row.id) void deleteRecurringIncome(row.id); }}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="card settings-card">
              <p className="settings-kicker">Forecast setup</p>
              <h3>Planned cash events</h3>
              <p className="muted">Use this for known future hits like rent, travel, or a manual transfer into savings.</p>
              <div className="cashflow-inline-form">
                <label>Title<input value={plannedCashflowDraft.title} onChange={(e) => setPlannedCashflowDraft((prev) => ({ ...prev, title: e.target.value }))} placeholder="Rent" /></label>
                <label>Amount<input type="number" value={plannedCashflowDraft.amount} onChange={(e) => setPlannedCashflowDraft((prev) => ({ ...prev, amount: e.target.value }))} placeholder="0" /></label>
                <label>Kind<select value={plannedCashflowDraft.kind} onChange={(e) => setPlannedCashflowDraft((prev) => ({ ...prev, kind: e.target.value as PlannedCashflowKind }))}><option value="planned_expense">Planned expense</option><option value="savings_transfer">Savings transfer</option></select></label>
                <label>Date<input type="date" value={plannedCashflowDraft.date} onChange={(e) => setPlannedCashflowDraft((prev) => ({ ...prev, date: e.target.value }))} /></label>
                <label>Category<input value={plannedCashflowDraft.category} onChange={(e) => setPlannedCashflowDraft((prev) => ({ ...prev, category: e.target.value }))} placeholder="Housing, Savings, Travel" /></label>
              </div>
              {plannedCashflowDraftError ? <p className="error-text">{plannedCashflowDraftError}</p> : null}
              <div className="settings-actions">
                <button type="button" onClick={() => { void savePlannedCashflowDraft(); }}>
                  {plannedCashflowDraft.id ? "Update event" : "Add event"}
                </button>
                {plannedCashflowDraft.id ? <button type="button" className="ghost-btn" onClick={resetPlannedCashflowDraft}>Cancel edit</button> : null}
              </div>
              <div className="cashflow-settings-list">
                {plannedCashflows.length === 0 ? (
                  <p className="muted">No planned cash events yet. Add the future expenses or transfers you already know about.</p>
                ) : (
                  plannedCashflows.map((row) => (
                    <div key={row.id} className="cashflow-settings-item">
                      <div>
                        <strong>{row.title}</strong>
                        <p className="muted">
                          {row.kind === "savings_transfer" ? "Savings transfer" : "Planned expense"}
                          {" · "}
                          {money(row.amount)}
                          {" · "}
                          {format(parseISO(row.date), "MMM d, yyyy")}
                          {row.category ? ` · ${row.category}` : ""}
                        </p>
                      </div>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => {
                            setPlannedCashflowDraft({
                              id: row.id ?? null,
                              title: row.title,
                              amount: String(row.amount),
                              kind: row.kind,
                              date: format(parseISO(row.date), "yyyy-MM-dd"),
                              category: row.category ?? "",
                            });
                            setPlannedCashflowDraftError("");
                          }}
                        >
                          Edit
                        </button>
                        <button type="button" className="ghost-btn" onClick={() => { if (row.id) void deletePlannedCashflow(row.id); }}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="card settings-card">
              <p className="settings-kicker">Appearance</p>
              <h3>Theme</h3>
              <div className="appearance-segment" role="tablist" aria-label="Theme mode">
                {(["system", "light", "dark"] as const).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={themePreference === opt ? "active" : ""}
                    onClick={() => setThemePreference(opt)}
                  >
                    {opt[0].toUpperCase() + opt.slice(1)}
                  </button>
                ))}
              </div>
            </section>

            <section className="card settings-card">
              <p className="settings-kicker">Privacy</p>
              <h3>Face ID lock</h3>
              <p className="muted">
                {bioLockSupported
                  ? bioLockPlatformReady
                    ? "Use Face ID, Touch ID, or device PIN when opening Zero (HTTPS required)."
                    : "Uses Web Authentication on this device when available — try Enable below."
                  : "Requires HTTPS (or localhost for testing) and a compatible browser."}
              </p>
              {bioLockCredentialPresent ? (
                <div className="settings-actions settings-actions-stack">
                  <p className="muted">
                    App lock is <strong>on</strong>.
                  </p>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => {
                      const ok = window.confirm(
                        "Turn off Face ID lock? Anyone who has this device can open Zero.",
                      );
                      if (!ok) return;
                      bioLockClear();
                      setBioLockFeatureEnabled(false);
                      setBioLockCredentialPresent(false);
                      setBioLockUnlocked(true);
                      setBioLockUiHint("Face ID lock is off.");
                    }}
                  >
                    Turn off Face ID lock
                  </button>
                </div>
              ) : (
                <div className="settings-actions">
                  <button
                    type="button"
                    disabled={!bioLockSupported}
                    onClick={() => {
                      void (async () => {
                        setBioLockUiHint("");
                        const r = await bioLockRegister();
                        switch (r.ok) {
                          case true:
                            setBioLockFeatureEnabled(true);
                            setBioLockCredentialPresent(true);
                            setBioLockUnlocked(true);
                            setBioLockUiHint("Face ID lock is on.");
                            break;
                          case false:
                            setBioLockUiHint(r.message);
                            break;
                          default:
                            break;
                        }
                      })();
                    }}
                  >
                    Enable Face ID lock
                  </button>
                </div>
              )}
              {bioLockUiHint ? <p className="muted">{bioLockUiHint}</p> : null}
            </section>

            <section className="card settings-card">
              <p className="settings-kicker">Notifications</p>
              <h3>Alerts and reminders</h3>
              <div className="settings-actions settings-streak-protection-row">
                <div className="settings-streak-protection-copy">
                  <strong>Streak protection</strong>
                  <span className="muted">Notifies you before a multi-day streak drops if today isn&apos;t logged yet.</span>
                </div>
                <label className="ios-switch">
                  <input
                    type="checkbox"
                    checked={streakProtectionEnabled}
                    onChange={(e) => setStreakProtectionEnabled(e.target.checked)}
                  />
                  <span />
                </label>
              </div>

              <details className="notification-copy-details">
                <summary className="notification-copy-summary">Customize push wording</summary>
                <p className="muted notification-copy-intro">
                  Optional titles and message bodies for each alert type. Leave blank to use the built-in rotating lines.
                  Placeholders get filled when the notification is sent.
                </p>
                <div className="notification-copy-list">
                  {PUSH_NOTIFICATION_KIND_META.map((meta) => {
                    const row = settings.pushNotificationMessages?.[meta.id];
                    const hasCustom = Boolean((row?.title ?? "").trim() || (row?.body ?? "").trim());
                    return (
                      <div key={meta.id} className="notification-copy-row">
                        <div className="notification-copy-row-head">
                          <strong>{meta.label}</strong>
                          <span className="muted">{meta.hint}</span>
                        </div>
                        <label className="notification-copy-label">
                          Title <span className="muted">(optional)</span>
                          <input
                            type="text"
                            value={row?.title ?? ""}
                            placeholder="App default"
                            onChange={(e) => patchPushNotificationMessage(meta.id, { title: e.target.value })}
                          />
                        </label>
                        <label className="notification-copy-label">
                          Message <span className="muted">(optional)</span>
                          <textarea
                            rows={2}
                            value={row?.body ?? ""}
                            placeholder="App default"
                            onChange={(e) => patchPushNotificationMessage(meta.id, { body: e.target.value })}
                          />
                        </label>
                        {hasCustom ? (
                          <button type="button" className="ghost-btn notification-copy-clear" onClick={() => clearPushNotificationMessage(meta.id)}>
                            Reset this type
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="ghost-btn notification-copy-reset-all"
                  onClick={() => updateSettings({ pushNotificationMessages: {} })}
                >
                  Reset all custom wording
                </button>
              </details>

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
              <p className="muted">This removes transactions, subscriptions, forecast items, settings, and rules from this device.</p>
              <button
                className="danger-btn"
                type="button"
                onClick={async () => {
                  const ok = window.confirm("Clear all local app data? This cannot be undone.");
                  if (!ok) return;
                  await clearData();
                  setDismissedSubscriptionSuggestions([]);
                  localStorage.removeItem("zero_subscription_detection_dismissed_v1");
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
        {markPaidTarget?.id != null && (
          <MarkBillPaidSheet
            key={markPaidTarget.id}
            subscription={markPaidTarget}
            onClose={() => setMarkPaidTarget(null)}
            onConfirm={async ({ logExpense, expenseAmount, category, note }) => {
              const id = markPaidTarget.id!;
              const nextBillingDate = nextDateFromCycle(markPaidTarget.nextBillingDate, markPaidTarget.cycle);
              await updateSubscription(id, { nextBillingDate });
              if (logExpense) {
                const clean = normalizeTransactionInput({
                  amount: expenseAmount,
                  type: "expense",
                  category: category || undefined,
                  note: note || undefined,
                  date: new Date().toISOString(),
                });
                await addTransaction(clean);
              }
              setMarkPaidTarget(null);
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
            key={editingTimelineEvent.id}
            title={editingTimelineEvent.title}
            hour={editingTimelineEvent.hour}
            startMinute={editingTimelineEvent.startMinute}
            durationMinutes={editingTimelineEvent.durationMinutes ?? 60}
            category={editingTimelineEvent.category}
            subtasks={editingTimelineEvent.subtasks}
            timeStep={900}
            showSubtasks
            onClose={() => { setShowTimelineSheet(false); setEditingTimelineEvent(null); }}
            onSave={({ title, hour, startMinute, durationMinutes, category, subtasks }) => {
              setTimelineEvents((prev) => {
                const exists = prev.some((e) => e.id === editingTimelineEvent.id);
                const nextEvent: TimelineEvent = {
                  ...editingTimelineEvent,
                  title,
                  hour,
                  startMinute,
                  durationMinutes,
                  category,
                  subtasks,
                };
                if (exists) return prev.map((e) => e.id === editingTimelineEvent.id ? nextEvent : e);
                return [...prev, nextEvent];
              });
              setShowTimelineSheet(false);
              setEditingTimelineEvent(null);
            }}
            onDelete={() => {
              setTimelineEvents((prev) => prev.filter((e) => e.id !== editingTimelineEvent.id));
              setShowTimelineSheet(false);
              setEditingTimelineEvent(null);
            }}
          />
        )}
        {showTemplateSheet && editingTemplateBlock && (
          <RoutineBlockSheet
            key={editingTemplateBlock.id}
            title={editingTemplateBlock.name}
            hour={editingTemplateBlock.hour}
            durationMinutes={editingTemplateBlock.durationMinutes}
            category={editingTemplateBlock.category}
            timeStep={3600}
            showSubtasks={false}
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
            onDelete={() => {
              setRoutineTemplate((prev) => prev.filter((e) => e.id !== editingTemplateBlock.id));
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
                      <span>{formatTimelineClock(event)} · {event.title}</span>
                    </div>
                  ))}
                  {sortedTimelineEvents.length === 0 && <p className="muted">Your best hours are still open. Add one intentional block in Routine.</p>}
                </div>
                <div className="morning-news">
                  <div className="row">
                    <h4>Recent Somaliland on X</h4>
                    <button type="button" className="ghost-btn" onClick={() => { void refreshRegionalBrief(); }}>Refresh</button>
                  </div>
                  {!newsLoading && recentNewsItems.length > 0 && (
                    <div className="news-feed-list">
                      {recentNewsItems.slice(0, 3).map((item) => (
                        <button
                          key={`morning-${item.url}`}
                          type="button"
                          className="news-feed-item"
                          onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}
                        >
                          <div className="news-feed-meta">
                            <span className="news-feed-source">{item.source}</span>
                            <span className="muted">
                              {item.publishedAt
                                ? `${formatDistanceToNow(new Date(item.publishedAt), { addSuffix: true })}`
                                : "Recent"}
                            </span>
                          </div>
                          <strong className="news-feed-title">{item.title}</strong>
                          <p className="muted news-feed-description">{item.description}</p>
                        </button>
                      ))}
                    </div>
                  )}
                  {newsLoading && <p className="muted">Loading latest Somaliland updates...</p>}
                  {!newsLoading && recentNewsItems.length === 0 && <p className="muted">No recent Somaliland posts yet. Tap refresh to check again.</p>}
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
                <h3 className="coach-zero-heading">
                  {groqBackendLive ? (
                    <span
                      className="coach-zero-live-dot"
                      title="Groq backend ready"
                      aria-label="Groq backend connected"
                    />
                  ) : null}
                  Coach Zero
                </h3>
                <p className="ai-chat-subtitle">
                  {assistantBusy
                    ? "Thinking…"
                    : chat.length === 0
                      ? "Live snapshot updates as money, tasks, and calendar change."
                      : "Pick up the thread below."}
                </p>
              </div>
              <div className="ai-chat-actions">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setChat([]);
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
              {chat.length === 0 && !assistantBusy && settings ? (
                <p className="ai-bubble assistant coach-zero-situation">{coachZeroSituationIntro}</p>
              ) : null}
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
            {whatIfScenarios.length > 0 && (
              <div className="what-if-compare">
                <div className="row">
                  <p className="ai-chat-kicker">WHAT-IF MEMORY</p>
                  <button type="button" className="ghost-btn" onClick={() => setWhatIfScenarios([])}>Clear</button>
                </div>
                {whatIfScenarios.slice(0, 3).map((scenario) => (
                  <article key={scenario.id} className="what-if-row">
                    <strong>{scenario.title}</strong>
                    <p className="muted">
                      {money(scenario.currentMonthEnd)} {"->"} {money(scenario.simulatedMonthEnd)} ({scenario.totalSavings >= 0 ? "+" : ""}{money(scenario.totalSavings)})
                    </p>
                  </article>
                ))}
              </div>
            )}
            <div className="assistant-input ai-input-wrap">
              <input
                value={assistantQuestion}
                onChange={(e) => setAssistantQuestion(e.target.value)}
                placeholder="Tell Coach Zero what's going on…"
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
      <AnimatePresence>
        {showWhatIfBuilder && (
          <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.section className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }}>
              <div className="row">
                <h3>What-if builder</h3>
                <button type="button" className="ghost-btn" onClick={() => setShowWhatIfBuilder(false)}>Close</button>
              </div>
              <label>
                Cut category
                <input
                  value={whatIfCutCategory}
                  onChange={(e) => setWhatIfCutCategory(e.target.value)}
                  placeholder="food, transport, shopping..."
                />
              </label>
              <label>
                Cut by {Math.round(whatIfCutPercent)}%
                <input
                  type="range"
                  min={1}
                  max={80}
                  value={whatIfCutPercent}
                  onChange={(e) => setWhatIfCutPercent(Number(e.target.value) || 15)}
                />
              </label>
              <label>
                Cancel subscription (optional)
                <select
                  value={String(whatIfCancelSubscriptionId ?? "")}
                  onChange={(e) => setWhatIfCancelSubscriptionId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">No cancellation</option>
                  {subscriptions
                    .filter((s) => typeof s.id === "number")
                    .map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                </select>
              </label>
              {builderScenarioPreview && (
                <div className="what-if-preview">
                  <p className="muted">Preview</p>
                  {builderScenarioPreview.baseline.changes.map((c) => <p key={c} className="muted">- {c}</p>)}
                  <p className="muted">Month-end: {money(builderScenarioPreview.baseline.currentMonthEnd)} {"->"} {money(builderScenarioPreview.baseline.simulatedMonthEnd)}</p>
                </div>
              )}
              <div className="row">
                <button type="button" className="ghost-btn" onClick={() => setShowWhatIfBuilder(false)}>Cancel</button>
                <button
                  type="button"
                  onClick={() => {
                    setShowWhatIfBuilder(false);
                    setAssistantOpen(true);
                    void askAssistant(builderScenarioQuestion);
                  }}
                >
                  Run in chat
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type RoutineBlockSavePayload = {
  title: string;
  hour: number;
  startMinute?: number;
  durationMinutes: number;
  category: TimelineCategory;
  subtasks?: string[];
};

function RoutineBlockSheet({
  title: initialTitle,
  hour: initialHour,
  startMinute: initialStartMinute = 0,
  durationMinutes: initialDuration,
  category: initialCategory,
  subtasks: initialSubtasks,
  timeStep = 900,
  showSubtasks = false,
  onClose,
  onSave,
  onDelete,
}: {
  title: string;
  hour: number;
  startMinute?: number;
  durationMinutes: number;
  category: TimelineCategory;
  subtasks?: string[];
  timeStep?: number;
  showSubtasks?: boolean;
  onClose: () => void;
  onSave: (payload: RoutineBlockSavePayload) => void;
  onDelete?: () => void;
}) {
  const pad2 = (n: number, max: number) => String(Math.max(0, Math.min(max, n))).padStart(2, "0");
  const [title, setTitle] = useState(initialTitle);
  const [startTime, setStartTime] = useState(() => {
    const h = Math.max(0, Math.min(23, initialHour));
    const m = Math.max(0, Math.min(59, initialStartMinute ?? 0));
    return `${pad2(h, 23)}:${pad2(m, 59)}`;
  });
  const [endTime, setEndTime] = useState(() => {
    const startTotal = Math.max(0, Math.min(23, initialHour)) * 60 + Math.max(0, Math.min(59, initialStartMinute ?? 0));
    let endTotal = startTotal + Math.max(15, initialDuration);
    endTotal = Math.min(endTotal, 24 * 60 - 1);
    return `${pad2(Math.floor(endTotal / 60), 23)}:${pad2(endTotal % 60, 59)}`;
  });
  const [category, setCategory] = useState<TimelineCategory>(initialCategory);
  const [keepAdding, setKeepAdding] = useState(false);
  const [subtasksText, setSubtasksText] = useState(() =>
    initialSubtasks && initialSubtasks.length > 0 ? initialSubtasks.join("\n") : "",
  );

  const parseClock = (t: string) => {
    const [hRaw, mRaw] = t.split(":");
    const h = Math.max(0, Math.min(23, Number(hRaw) || 0));
    const m = Math.max(0, Math.min(59, Number(mRaw) || 0));
    return { h, m, total: h * 60 + m };
  };

  const startParsed = parseClock(startTime);
  const endParsed = parseClock(endTime);
  let startTotal = startParsed.total;
  let endTotal = endParsed.total;
  if (endTotal <= startTotal) endTotal += 24 * 60;
  const rawDuration = endTotal - startTotal;
  const durationNum = Math.max(15, Math.min(24 * 60 - startTotal, rawDuration));

  const hourNum = startParsed.h;
  const minuteNum = startParsed.m;

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
        const payload: RoutineBlockSavePayload = {
          title: title.trim(),
          hour: hourNum,
          durationMinutes: durationNum,
          category,
        };
        if (timeStep <= 900) payload.startMinute = minuteNum;
        if (showSubtasks) {
          const lines = subtasksText.split("\n").map((s) => s.trim()).filter(Boolean);
          payload.subtasks = lines.length > 0 ? lines : undefined;
        }
        onSave(payload);
        if (keepAdding) {
          setTitle("");
          const nextStart = startTotal + durationNum;
          if (nextStart <= 24 * 60 - 30) {
            setStartTime(`${pad2(Math.floor(nextStart / 60), 23)}:${pad2(nextStart % 60, 59)}`);
            const nextEnd = Math.min(nextStart + durationNum, 24 * 60 - 1);
            setEndTime(`${pad2(Math.floor(nextEnd / 60), 23)}:${pad2(nextEnd % 60, 59)}`);
          }
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
                const st = preset.hour * 60;
                const et = Math.min(st + preset.duration, 24 * 60 - 1);
                setStartTime(`${pad2(preset.hour, 23)}:00`);
                setEndTime(`${pad2(Math.floor(et / 60), 23)}:${pad2(et % 60, 59)}`);
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
            Start
            <input type="time" step={timeStep} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label>
            End
            <input type="time" step={timeStep} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
        </div>
        <p className="muted">Duration: {Math.floor(durationNum / 60)}h {durationNum % 60}m</p>
        {showSubtasks && (
          <label>
            Subtasks (optional)
            <textarea value={subtasksText} onChange={(e) => setSubtasksText(e.target.value)} rows={3} placeholder="One line per subtask" />
          </label>
        )}
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
          {onDelete && <button type="button" className="ghost-btn" onClick={onDelete}>Delete</button>}
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
  const [message, setMessage] = useState(item.message || "");
  const [mode, setMode] = useState<"in" | "clock">(item.mode ?? "in");
  const [delaySeconds, setDelaySeconds] = useState(String(item.delaySeconds));
  const [clockTime, setClockTime] = useState(item.clockTime || "08:00");
  const [enabled, setEnabled] = useState(item.enabled);
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => {
        e.preventDefault();
        if (!label.trim()) return;
        onSave({
          ...item,
          label: label.trim(),
          message: message.trim(),
          mode,
          delaySeconds: Math.max(60, Number(delaySeconds) || 1800),
          clockTime,
          enabled,
        });
      }}>
        <h3>Reminder</h3>
        <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} required /></label>
        <label>Message<textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="What should this reminder say?" /></label>
        <div className="task-filter-row">
          <button type="button" className={mode === "in" ? "active" : ""} onClick={() => setMode("in")}>Remind me in</button>
          <button type="button" className={mode === "clock" ? "active" : ""} onClick={() => setMode("clock")}>Clock time</button>
        </div>
        {mode === "in" ? (
          <label>Remind me in (minutes)<input type="number" min={1} value={String(Math.max(1, Math.round((Number(delaySeconds) || 1800) / 60)))} onChange={(e) => setDelaySeconds(String(Math.max(60, Number(e.target.value || 0) * 60)))} /></label>
        ) : (
          <label>At time<input type="time" value={clockTime} onChange={(e) => setClockTime(e.target.value)} /></label>
        )}
        <label className="routine-check-item">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Active</span>
        </label>
        <div className="row"><button type="button" className="ghost-btn" onClick={onClose}>Cancel</button><button type="submit">Save</button></div>
      </motion.form>
    </motion.div>
  );
}

function MoneyExplanationCard({ explanation }: { explanation: MoneyMetricExplanation }) {
  return (
    <article className="card money-explanation-card" role="note" aria-label={explanation.title}>
      <div className="money-explanation-head">
        <strong>{explanation.title}</strong>
      </div>
      <p className="muted">{explanation.summary}</p>
      <div className="money-explanation-list">
        {explanation.bullets.map((bullet) => (
          <p key={bullet} className="muted">
            {bullet}
          </p>
        ))}
      </div>
    </article>
  );
}

function TransactionRow({ tx, onDelete, onEdit }: { tx: any; onDelete: () => void; onEdit: () => void }) {
  const cat = getCategoryDefinition(tx.category || "General");
  const txDateLabel = (() => {
    const parsed = new Date(tx.date);
    return Number.isNaN(+parsed) ? "Today" : format(parsed, "EEE d MMM");
  })();
  return (
    <motion.div className="tx-row" drag="x" dragConstraints={{ left: 0, right: 0 }} onDragEnd={(_, info) => { if (info.offset.x < -80) onDelete(); if (info.offset.x > 80) onEdit(); }}>
      <div className="tx-row-main">
        <div className="tx-row-top">
          <strong className="tx-category-badge" style={{ background: cat.color.bg, color: cat.color.text, boxShadow: `inset 0 0 0 1px ${cat.color.ring}` }}>
            {tx.category}
          </strong>
          <span className={`tx-type-pill ${tx.type}`}>{tx.type === "income" ? "Income" : "Expense"}</span>
        </div>
        <p className="muted tx-note">{tx.note || "No note"}</p>
        <p className="muted tx-date">{txDateLabel}</p>
      </div>
      <div className="tx-row-right">
        <strong className={tx.type === "income" ? "positive" : "negative"}>{money(tx.amount)}</strong>
      </div>
    </motion.div>
  );
}

type SubscriptionBillRow = Subscription & { dueDate: string; urgency: string };

function SubscriptionRow({
  row,
  onEdit,
  onMarkPaid,
}: {
  row: SubscriptionBillRow;
  onEdit: () => void;
  onMarkPaid: () => void;
}) {
  const date = row.dueDate;
  return (
    <div className={`urgency ${row.urgency}`}>
      <div><strong>{row.name}</strong><p>{formatDistanceToNow(parseISO(date), { addSuffix: true })}</p></div>
      <div className="inline-actions">
        <strong>{money(row.amount)}</strong>
        {row.id != null && (
          <button type="button" className="ghost-btn" onClick={onMarkPaid}>Paid</button>
        )}
        <button type="button" className="ghost-btn" onClick={onEdit}>Edit</button>
      </div>
    </div>
  );
}

function MarkBillPaidSheet({
  subscription,
  onClose,
  onConfirm,
}: {
  subscription: Subscription;
  onClose: () => void;
  onConfirm: (opts: { logExpense: boolean; expenseAmount: number; category: string; note: string }) => Promise<void>;
}) {
  const [logExpense, setLogExpense] = useState(true);
  const [amount, setAmount] = useState(String(subscription.amount));
  const [category, setCategory] = useState("Subscriptions");
  const [note, setNote] = useState(`${subscription.name} paid`);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const nextDateIso = useMemo(
    () => nextDateFromCycle(subscription.nextBillingDate, subscription.cycle),
    [subscription.nextBillingDate, subscription.cycle],
  );

  const handleConfirm = async () => {
    setError("");
    if (logExpense) {
      try {
        normalizeTransactionInput({
          amount: Number(amount),
          type: "expense",
          category: category || undefined,
          note: note || undefined,
          date: new Date().toISOString(),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Expense is invalid.");
        return;
      }
    }
    setBusy(true);
    try {
      await onConfirm({
        logExpense,
        expenseAmount: Number(amount),
        category: category.trim(),
        note: note.trim(),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }}>
        <h3>Mark paid</h3>
        <p className="muted">
          <strong>{subscription.name}</strong> — next billing moves from{" "}
          {format(parseISO(subscription.nextBillingDate), "MMM d, yyyy")} to {format(parseISO(nextDateIso), "MMM d, yyyy")}.
        </p>
        <label className="mark-paid-checkbox">
          <input type="checkbox" checked={logExpense} onChange={(e) => setLogExpense(e.target.checked)} />
          Log expense today ({money(subscription.amount)} default)
        </label>
        {logExpense && (
          <>
            <label>
              Amount
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Category
              <input value={category} onChange={(e) => setCategory(e.target.value)} list="mark-paid-categories" placeholder="Subscriptions" />
            </label>
            <datalist id="mark-paid-categories">{CATEGORY_NAMES.map((c) => <option key={c} value={c} />)}</datalist>
            <label>
              Note
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
            </label>
          </>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" onClick={() => void handleConfirm()} disabled={busy}>{busy ? "Saving…" : "Confirm"}</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function TransactionSheet({ initial, onClose, onSave }: { initial?: any; onClose: () => void; onSave: (p: { amount: number; type: TxType; category?: string; note?: string; date: string }) => Promise<void> }) {
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [type, setType] = useState<TxType>(initial?.type ?? "expense");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [date, setDate] = useState(initial ? format(parseISO(initial.date), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"));
  const [error, setError] = useState("");
  const quality = useMemo(
    () => getTransactionQualitySnapshot({ amount: Number(amount), type, category, note, date: new Date(date).toISOString() }),
    [amount, type, category, note, date],
  );
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          const clean = normalizeTransactionInput({
            amount: Number(amount),
            type,
            category: category || undefined,
            note,
            date: new Date(date).toISOString(),
          });
          await onSave(clean);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Transaction is invalid.");
        }
      }}>
        <h3>{initial ? "Edit transaction" : "Quick transaction"}</h3>
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-5 or 2000" required /></label>
        <label>Type<select value={type} onChange={(e) => setType(e.target.value as TxType)}><option value="expense">Expense</option><option value="income">Income</option></select></label>
        <label>Category<input value={category} onChange={(e) => setCategory(e.target.value)} list="categories" placeholder="Auto if empty" /></label>
        <datalist id="categories">{CATEGORY_NAMES.map((c) => <option key={c} value={c} />)}</datalist>
        <label>Note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" /></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <p className="muted">Quality score: <strong>{quality.score}/100</strong> ({quality.grade})</p>
        {quality.warnings.length > 0 && <p className="muted">Check: {quality.warnings.join(", ")}</p>}
        {error && <p className="error-text">{error}</p>}
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
  const [info, setInfo] = useState("");

  const parseRows = () => {
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((line, idx) => {
      const [amountRaw, typeRaw, categoryRaw, noteRaw, dateRaw] = line.split(",").map((x) => x?.trim());
      try {
        return normalizeTransactionInput({
          amount: Number(amountRaw),
          type: (typeRaw?.toLowerCase() ?? "") as TxType,
          category: categoryRaw || undefined,
          note: noteRaw || undefined,
          date: dateRaw ? new Date(dateRaw).toISOString() : new Date().toISOString(),
        });
      } catch {
        throw new Error(`Line ${idx + 1} is invalid. Format: amount,type,category,note,YYYY-MM-DD`);
      }
    });
    const { unique, duplicateCount } = dedupeNormalizedTransactions(parsed);
    setInfo(duplicateCount > 0 ? `${duplicateCount} duplicate line(s) were skipped automatically.` : "");
    return unique;
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
            setError("");
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
        {info && <p className="muted">{info}</p>}
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
  if (name === "ai") return (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M12 4.5 13.8 10.2 19.5 12l-5.7 1.8L12 19.5l-1.8-5.7L4.5 12l5.7-1.8L12 4.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="18.2" cy="5.8" r="1.2" fill="currentColor" />
    </svg>
  );
  if (name === "streak") return <svg viewBox="0 0 24 24" fill="none"><path d="M13.2 3.8c.3 2.5-.5 4-2.4 5.5-1.2 1-2.3 2.3-2.3 4.2 0 2.2 1.8 4 4 4 2.5 0 4.4-2 4.4-4.5 0-2.8-1.6-4.4-3.7-5.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.3 10.6c.2 1.4-.2 2.3-1.2 3-.6.5-1 1.1-1 2 0 1.1.9 2 2 2 1.2 0 2.1-.9 2.1-2.2 0-1.4-.8-2.3-1.9-2.8" fill="currentColor" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none"><path d="m12 4 1.9 3.8 4.1.6-3 2.9.7 4.1L12 13.4l-3.7 2 .7-4.1-3-2.9 4.1-.6L12 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
}
