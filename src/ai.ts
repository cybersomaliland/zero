import type { Settings, Subscription, Transaction } from "./types";

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

  const context = {
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
    },
    financialSummary: {
      transactionCount: params.transactions.length,
      subscriptionCount: params.subscriptions.length,
      recentIncomeTotal,
      recentExpenseTotal,
      topSpendingCategories,
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
