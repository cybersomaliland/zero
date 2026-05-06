import type { Settings, Subscription, Transaction } from "./types";

export async function askGroqFinanceAssistant(params: {
  question: string;
  chatHistory: Array<{ role: "assistant" | "user"; text: string }>;
  transactions: Transaction[];
  subscriptions: Subscription[];
  settings: Settings;
  forecastData: Array<{ date: string; balance: number }>;
  financeSnapshot: {
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

  const context = {
    financeSnapshot: params.financeSnapshot,
    settings: params.settings,
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
