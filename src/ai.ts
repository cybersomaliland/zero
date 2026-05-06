import type { Settings, Subscription, Transaction } from "./types";

export async function askGroqFinanceAssistant(params: {
  question: string;
  chatHistory: Array<{ role: "assistant" | "user"; text: string }>;
  transactions: Transaction[];
  subscriptions: Subscription[];
  settings: Settings;
  forecastData: Array<{ date: string; balance: number }>;
  signal?: AbortSignal;
}) {
  const context = {
    settings: params.settings,
    transactions: params.transactions,
    subscriptions: params.subscriptions,
    forecastData: params.forecastData,
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
    throw new Error(`Groq request failed: ${response.status}`);
  }

  const data = await response.json() as {
    answer?: string;
  };
  const content = data.answer?.trim();
  if (!content) throw new Error("Groq empty response");
  return content;
}
