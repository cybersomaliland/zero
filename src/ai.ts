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

  const context = {
    meta: {
      app: "Zero",
      today: todayIso,
      currency: "USD",
    },
    financeSnapshot: params.financeSnapshot,
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
      chatHistory: params.chatHistory,
      context,
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

  const data = await response.json() as {
    answer?: string;
  };
  const content = data.answer?.trim();
  if (!content) throw new Error("Groq empty response");
  return content;
}
