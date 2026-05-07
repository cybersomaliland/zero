import type { Settings, Subscription, Transaction } from "./types";

function parseDateSafe(input: string) {
  const d = new Date(input);
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function askGroqFinanceAssistant(params: {
  question: string;
  chatHistory: Array<{ role: "assistant" | "user"; text: string }>;
  transactions: Transaction[];
  subscriptions: Subscription[];
  settings: Settings;
  forecastData: Array<{ date: string; balance: number }>;
  financeSnapshot: {
    monthlySalary: number;
    currentBalance: number;
    monthlyRealBalance: number;
    weeklySafeToUse: number;
    dailyAllowance: number;
    todaySpent: number;
    todayRemaining: number;
    weeklySpent: number;
    weeklyIncome: number;
    weeklyUpcomingSubs: number;
  };
  routineSnapshot: {
    userName: string;
    timeOfDay: "morning" | "afternoon" | "evening" | "night";
    currentBlock: { title: string; category: string; minutesLeft: number } | null;
    todayTimeline: Array<{ hour: number; title: string; category: string; durationMinutes?: number }>;
    checklist: {
      completedCount: number;
      totalCount: number;
      tasks: Array<{ title: string; priority: string; done: boolean }>;
    };
    templateBlocks: Array<{ hour: number; name: string; category: string; durationMinutes: number }>;
    planAhead: {
      tomorrow: Array<{ dayLabel: string; hour: number; title: string; category: string }>;
      laterThisWeek: Array<{ dayLabel: string; hour: number; title: string; category: string }>;
    };
    activeReminders: Array<{ label: string; delaySeconds: number; enabled: boolean }>;
  };
  onToken?: (chunk: string) => void;
  signal?: AbortSignal;
}) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const recentTransactions = [...params.transactions]
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .slice(0, 80);
  const upcomingSubscriptions = [...params.subscriptions]
    .sort((a, b) => +new Date(a.nextBillingDate) - +new Date(b.nextBillingDate))
    .slice(0, 40);
  const expenseTransactions = params.transactions.filter((t) => t.type === "expense");
  const spendingByCategory = expenseTransactions.reduce<Record<string, number>>((acc, tx) => {
    acc[tx.category] = (acc[tx.category] || 0) + Math.abs(tx.amount);
    return acc;
  }, {});
  const topSpendingCategories = Object.entries(spendingByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([category, amount]) => ({ category, amount }));
  const recentIncomeTotal = params.transactions
    .filter((t) => t.type === "income")
    .slice(-20)
    .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
  const recentExpenseTotal = expenseTransactions.slice(-80).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);
  const sixtyDaysAgo = new Date(now);
  sixtyDaysAgo.setDate(now.getDate() - 60);

  const last30Expenses = expenseTransactions
    .filter((t) => {
      const d = parseDateSafe(t.date);
      return d ? d >= thirtyDaysAgo : false;
    })
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const prev30Expenses = expenseTransactions
    .filter((t) => {
      const d = parseDateSafe(t.date);
      return d ? d >= sixtyDaysAgo && d < thirtyDaysAgo : false;
    })
    .reduce((sum, t) => sum + Math.abs(t.amount), 0);
  const spendingTrend30dPct = prev30Expenses > 0
    ? Number((((last30Expenses - prev30Expenses) / prev30Expenses) * 100).toFixed(1))
    : null;

  const avgDailyExpense30d = Number((last30Expenses / 30).toFixed(2));
  const upcoming30dSubscriptions = params.subscriptions
    .filter((s) => {
      const d = parseDateSafe(s.nextBillingDate);
      if (!d) return false;
      const days = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return days >= 0 && days <= 30;
    })
    .reduce((sum, s) => sum + s.amount, 0);
  const subscriptionsMonthlyRunRate = params.subscriptions.reduce((sum, s) => {
    if (s.cycle === "weekly") return sum + s.amount * 52 / 12;
    if (s.cycle === "yearly") return sum + s.amount / 12;
    return sum + s.amount;
  }, 0);
  const nearestForecastPoint = params.forecastData[0] ?? null;
  const lowestForecastPoint = [...params.forecastData].sort((a, b) => a.balance - b.balance)[0] ?? null;
  const currentBlockLine = params.routineSnapshot.currentBlock
    ? `${params.routineSnapshot.currentBlock.title} (${params.routineSnapshot.currentBlock.category}), ${params.routineSnapshot.currentBlock.minutesLeft} min left`
    : "No activity scheduled right now";
  const timelineLine = params.routineSnapshot.todayTimeline.length > 0
    ? params.routineSnapshot.todayTimeline
      .slice(0, 12)
      .map((b) => {
        const h = b.hour > 12 ? `${b.hour - 12}pm` : b.hour === 12 ? "12pm" : `${b.hour}am`;
        return `${h} ${b.title} [${b.category}]`;
      })
      .join(" | ")
    : "No blocks scheduled today";
  const checklistLine = params.routineSnapshot.checklist.totalCount > 0
    ? `${params.routineSnapshot.checklist.completedCount}/${params.routineSnapshot.checklist.totalCount} done: ${params.routineSnapshot.checklist.tasks
      .slice(0, 8)
      .map((t) => `${t.done ? "done" : "open"} ${t.title} (${t.priority})`)
      .join("; ")}`
    : "No tasks in today's checklist";
  const templateLine = params.routineSnapshot.templateBlocks.length > 0
    ? params.routineSnapshot.templateBlocks
      .slice(0, 8)
      .map((b) => {
        const h = b.hour > 12 ? `${b.hour - 12}pm` : b.hour === 12 ? "12pm" : `${b.hour}am`;
        return `${h} ${b.name} (${b.durationMinutes}m, ${b.category})`;
      })
      .join(" | ")
    : "Routine template is empty";
  const tomorrowLine = params.routineSnapshot.planAhead.tomorrow.length > 0
    ? params.routineSnapshot.planAhead.tomorrow
      .slice(0, 6)
      .map((i) => `${i.dayLabel} ${i.hour > 12 ? `${i.hour - 12}pm` : i.hour === 12 ? "12pm" : `${i.hour}am`} ${i.title} (${i.category})`)
      .join(" | ")
    : "No plan-ahead items for tomorrow";
  const weekLine = params.routineSnapshot.planAhead.laterThisWeek.length > 0
    ? params.routineSnapshot.planAhead.laterThisWeek
      .slice(0, 6)
      .map((i) => `${i.dayLabel} ${i.hour > 12 ? `${i.hour - 12}pm` : i.hour === 12 ? "12pm" : `${i.hour}am`} ${i.title} (${i.category})`)
      .join(" | ")
    : "No plan-ahead items later this week";
  const remindersLine = params.routineSnapshot.activeReminders.length > 0
    ? params.routineSnapshot.activeReminders
      .slice(0, 6)
      .map((r) => `${r.label} in ${Math.max(1, Math.round(r.delaySeconds / 60))}m (${r.enabled ? "on" : "off"})`)
      .join(" | ")
    : "No active reminders";
  const routineContextSummary = [
    `User: ${params.routineSnapshot.userName}. Time of day: ${params.routineSnapshot.timeOfDay}.`,
    `Current block: ${currentBlockLine}.`,
    `Today's timeline: ${timelineLine}.`,
    `Checklist: ${checklistLine}.`,
    `Template: ${templateLine}.`,
    `Plan ahead tomorrow: ${tomorrowLine}.`,
    `Plan ahead this week: ${weekLine}.`,
    `Reminders: ${remindersLine}.`,
  ].join("\n");

  const context = {
    meta: {
      app: "Zero",
      today: todayIso,
      currency: "USD",
    },
    financeSnapshot: params.financeSnapshot,
    routineSnapshot: params.routineSnapshot,
    routineContextSummary,
    settings: params.settings,
    understandingGuide: {
      definitions: {
        currentBalance: "Real cash currently available in account.",
        monthlySalary: "Planned monthly income target.",
        monthlyRealBalance: "Current balance adjusted by this month's net flow and upcoming bills/savings.",
        weeklySafeToUse: "Recommended safe amount to use this week.",
      },
      responseStyle: "Personal, practical, short, and number-driven.",
      responseContract: [
        "When possible, answer with a direct yes/no or one-sentence verdict first.",
        "Use financeSnapshot numbers first; use history only to support the verdict.",
        "If information is missing for a reliable answer, ask one precise clarifying question.",
        "Do not invent transactions, dates, balances, or income.",
      ],
    },
    financialSummary: {
      transactionCount: params.transactions.length,
      subscriptionCount: params.subscriptions.length,
      recentIncomeTotal,
      recentExpenseTotal,
      topSpendingCategories,
    },
    financialSignals: {
      avgDailyExpense30d,
      last30Expenses: Number(last30Expenses.toFixed(2)),
      previous30Expenses: Number(prev30Expenses.toFixed(2)),
      spendingTrend30dPct,
      upcoming30dSubscriptions: Number(upcoming30dSubscriptions.toFixed(2)),
      subscriptionsMonthlyRunRate: Number(subscriptionsMonthlyRunRate.toFixed(2)),
      nearestForecastPoint,
      lowestForecastPoint,
    },
    recentTransactions,
    upcomingSubscriptions,
    forecastData: params.forecastData.slice(0, 30),
  };

  const response = await fetch("/api/groq", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question: params.question,
      chatHistory: params.chatHistory.slice(-10),
      context,
      stream: true,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const err = await response.json() as { error?: string; detail?: string };
      detail = err.detail || err.error || "";
    } catch {
      // ignore parse error
    }
    throw new Error(`Groq request failed: ${response.status}${detail ? ` - ${detail}` : ""}`);
  }

  if (!response.body) throw new Error("Groq stream unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    content += chunk;
    params.onToken?.(chunk);
  }
  content = content.trim();
  if (!content) throw new Error("Groq empty response");
  return content;
}
