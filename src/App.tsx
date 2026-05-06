import { AnimatePresence, motion } from "framer-motion";
import { differenceInCalendarDays, eachDayOfInterval, endOfMonth, format, formatDistanceToNow, getDay, isSameWeek, parseISO, startOfDay, startOfMonth } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { askGroqFinanceAssistant } from "./ai";
import { CATEGORY_NAMES, getCategoryDefinition } from "./categories";
import { askFinanceAssistant, forecast, generateAiAdvice, getUpcomingBills, money } from "./logic";
import { fetchSomalilandNews, type NewsItem } from "./news";
import { useZeroStore } from "./store";
import type { Subscription, SubscriptionCycle, TxType } from "./types";

const tabs = ["Home", "Transactions", "Subscriptions", "Insights", "Settings"] as const;
type Tab = (typeof tabs)[number];
const tabMeta: Record<Tab, { icon: "home" | "activity" | "subscriptions" | "insights" | "settings"; label: string }> = {
  Home: { icon: "home", label: "Home" },
  Transactions: { icon: "activity", label: "Activity" },
  Subscriptions: { icon: "subscriptions", label: "Subs" },
  Insights: { icon: "insights", label: "Insights" },
  Settings: { icon: "settings", label: "Settings" },
};
const DEFAULT_CHAT: Array<{ role: "assistant" | "user"; text: string }> = [
  { role: "assistant", text: "I am your Zero AI assistant. Ask about spending, subscriptions, or future balance." },
];

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
  const [assistantEngine, setAssistantEngine] = useState<"groq" | "fallback">(
    (import.meta as { env?: Record<string, string> }).env?.VITE_GROQ_API_KEY ? "groq" : "fallback",
  );
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
    localStorage.setItem("zero_ai_chat_v1", JSON.stringify(chat));
  }, [chat]);

  useEffect(() => {
    if (!assistantOpen) return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [assistantOpen, chat, assistantBusy]);

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
  const monthlySalary = settings?.currentBalance ?? 0;
  const weeklySalaryAllocation = monthlySalary / 4.33;
  const monthlySavingsReserve = settings?.reservedSavings ?? 0;
  const weeklySavingsReserve = monthlySavingsReserve / 4.33;
  const weeklyRealBalance = weeklySalaryAllocation + weeklyTransactionsNet - weeklyUpcomingSubs - weeklySavingsReserve;
  const monthlyRealBalance = monthlySalary + monthlyTransactionsNet - monthlyUpcomingSubs - monthlySavingsReserve;
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
    () => (settings ? forecast(transactions, subscriptions, { ...settings, currentBalance: monthlySalary }) : []),
    [transactions, subscriptions, settings, monthlySalary],
  );
  const aiAdvice = useMemo(() => generateAiAdvice(transactions, subscriptions), [transactions, subscriptions]);
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
    const nextHistory = [...chat, { role: "user", text }] as Array<{ role: "assistant" | "user"; text: string }>;
    setChat(nextHistory);
    setAssistantBusy(true);
    try {
      const answer = await askGroqFinanceAssistant({
        question: text,
        chatHistory: nextHistory,
        transactions,
        subscriptions,
        settings,
        forecastData,
      });
      setAssistantEngine("groq");
      setChat((c) => [...c, { role: "assistant", text: answer }]);
    } catch {
      const fallback = askFinanceAssistant(text, transactions, subscriptions, settings, forecastData);
      setAssistantEngine("fallback");
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
                <p className="muted">Tap “Refresh news” to load hot headlines.</p>
              )}
              {newsLoading && <p className="muted">Loading latest headlines...</p>}
              {!newsLoading && newsError && <p className="muted">{newsError}</p>}
              {!newsLoading && !newsError && newsItems.length > 0 && (
                <button
                  type="button"
                  className="news-hot-item"
                  onClick={() => window.open(newsItems[activeHeadlineIndex].url, "_blank", "noopener,noreferrer")}
                >
                  <span className="news-hot-label">Hot headline</span>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.strong
                      key={newsItems[activeHeadlineIndex].url}
                      className="news-hot-title"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.25 }}
                    >
                      {newsItems[activeHeadlineIndex].title}
                    </motion.strong>
                  </AnimatePresence>
                  <span className="muted">{newsItems[activeHeadlineIndex].source}</span>
                </button>
              )}
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
          <>
            <section className="card">
              <div className="row">
                <h3>AI-powered insights</h3>
                <span className="badge">Local AI</span>
              </div>
              {aiAdvice.map((tip) => <p key={tip} className="insight">{tip}</p>)}
            </section>
            <section className="card">
              <h3>Cash flow forecast (60 days)</h3>
              <div className="chart">
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={forecastData}>
                    <defs><linearGradient id="bal" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0A84FF" stopOpacity={0.45} /><stop offset="95%" stopColor="#0A84FF" stopOpacity={0.05} /></linearGradient></defs>
                    <XAxis dataKey="date" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="balance" stroke="#0A84FF" fill="url(#bal)" strokeWidth={3} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="card">
              <h3>Weekly snapshot</h3>
              <Snapshot transactions={transactions} settingsBalance={weeklyRealBalance} />
            </section>
          </>
        )}

        {tab === "Settings" && (
          <section className="card">
            <h3>Settings</h3>
            <label>Monthly salary <input type="number" value={settings.currentBalance} onChange={(e) => updateSettings({ currentBalance: Number(e.target.value) })} /></label>
            <label>Monthly savings reserve <input type="number" value={settings.reservedSavings} onChange={(e) => updateSettings({ reservedSavings: Number(e.target.value) })} /></label>
            <p className="muted">Weekly safe formula: Weekly allocation {money(weeklySalaryAllocation)} + this week Tx {money(weeklyTransactionsNet)} - week subs {money(weeklyUpcomingSubs)} - weekly savings {money(weeklySavingsReserve)}</p>
            <p className="muted">Monthly balance formula: Salary {money(monthlySalary)} + month Tx {money(monthlyTransactionsNet)} - month subs {money(monthlyUpcomingSubs)} - savings {money(monthlySavingsReserve)}</p>
            <div className="inline-actions">
              <button type="button" onClick={() => { void enableNotifications(); }}>Enable notifications</button>
              <button type="button" className="ghost-btn" onClick={() => { void testNotification(); }} disabled={notifState !== "granted"}>
                Test notification
              </button>
            </div>
            <p className="muted">Notification status: {notifState}</p>
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
            <button type="button" onClick={() => { void refreshApp(); }}>Refresh app</button>
            <button
              className="danger-btn"
              type="button"
              onClick={async () => {
                const ok = window.confirm("Clear all local app data? This cannot be undone.");
                if (!ok) return;
                await clearData();
              }}
            >
              Clear data
            </button>
          </section>
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
      </AnimatePresence>

      <button className="ai-fab" type="button" onClick={() => setAssistantOpen((v) => !v)}>
        <IosIcon name="ai" />
      </button>
      <AnimatePresence>
        {assistantOpen && (
          <motion.section className="ai-chat" initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.96 }}>
            <div className="ai-chat-head">
              <div>
                <p className="ai-chat-kicker">Zero Intelligence</p>
                <h3>Personal finance co-pilot</h3>
              </div>
              <div className="ai-chat-actions">
                <span className={`ai-engine-pill ${assistantEngine === "groq" ? "connected" : "fallback"}`}>
                  {assistantEngine === "groq" ? "Groq connected" : "Fallback mode"}
                </span>
                <span className="ai-status-pill">{assistantBusy ? "Thinking" : "Online"}</span>
                <button type="button" onClick={() => setAssistantOpen(false)}>Close</button>
              </div>
            </div>
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
                void askAssistant("Where am I wasting money?");
              }}>
                Waste check
              </button>
              <button type="button" onClick={() => {
                void askAssistant("How much did I spend on food?");
              }}>
                Food spend
              </button>
              <button type="button" onClick={() => {
                void askAssistant("Can I afford a $15 meal today?");
              }}>
                Afford $15 meal?
              </button>
              <button type="button" onClick={() => {
                void askAssistant("Can I afford a $40 dinner today?");
              }}>
                Afford $40 dinner?
              </button>
              <button type="button" onClick={() => {
                void askAssistant("How much are my subscriptions?");
              }}>
                Subscription total
              </button>
              <button type="button" onClick={() => {
                void askAssistant("What is my next low balance point?");
              }}>
                Next low point
              </button>
            </div>
            <div className="assistant-input ai-input-wrap">
              <input
                value={assistantQuestion}
                onChange={(e) => setAssistantQuestion(e.target.value)}
                placeholder="Ask anything about your finance data..."
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
                {assistantBusy ? "Thinking..." : "Send"}
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

function Snapshot({ transactions, settingsBalance }: { transactions: any[]; settingsBalance: number }) {
  const monthExpenses = transactions.filter((t) => t.type === "expense" && format(parseISO(t.date), "yyyy-MM") === format(new Date(), "yyyy-MM"));
  const totalSpent = monthExpenses.reduce((a, t) => a + Math.abs(t.amount), 0);
  const byCategory: Record<string, number> = monthExpenses.reduce(
    (acc: Record<string, number>, t) => ({ ...acc, [t.category]: (acc[t.category] || 0) + Math.abs(t.amount) }),
    {},
  );
  const topCategory = (Object.entries(byCategory) as [string, number][])
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "None yet";
  return (
    <div className="snapshot-grid">
      <article><p className="muted">Total spent</p><strong>{money(totalSpent)}</strong></article>
      <article><p className="muted">Top category</p><strong>{topCategory}</strong></article>
      <article><p className="muted">Remaining</p><strong>{money(settingsBalance - totalSpent)}</strong></article>
    </div>
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
  if (name === "streak") return <svg viewBox="0 0 24 24" fill="none"><path d="M13.2 3.8c.3 2.5-.5 4-2.4 5.5-1.2 1-2.3 2.3-2.3 4.2 0 2.2 1.8 4 4 4 2.5 0 4.4-2 4.4-4.5 0-2.8-1.6-4.4-3.7-5.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M12.3 10.6c.2 1.4-.2 2.3-1.2 3-.6.5-1 1.1-1 2 0 1.1.9 2 2 2 1.2 0 2.1-.9 2.1-2.2 0-1.4-.8-2.3-1.9-2.8" fill="currentColor" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none"><path d="m12 4 1.9 3.8 4.1.6-3 2.9.7 4.1L12 13.4l-3.7 2 .7-4.1-3-2.9 4.1-.6L12 4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
}
