import type { Settings, Subscription, Transaction } from "./types";

type GroqMessage = { role: "system" | "user" | "assistant"; content: string };

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

export async function askGroqFinanceAssistant(params: {
  question: string;
  chatHistory: Array<{ role: "assistant" | "user"; text: string }>;
  transactions: Transaction[];
  subscriptions: Subscription[];
  settings: Settings;
  forecastData: Array<{ date: string; balance: number }>;
  signal?: AbortSignal;
}) {
  const key = (import.meta as { env?: Record<string, string> }).env?.VITE_GROQ_API_KEY;
  if (!key) throw new Error("Missing VITE_GROQ_API_KEY");

  const context = {
    settings: params.settings,
    transactions: params.transactions,
    subscriptions: params.subscriptions,
    forecastData: params.forecastData,
  };

  const recentConversation = params.chatHistory.slice(-12).map((m) => ({
    role: m.role,
    content: m.text,
  })) as GroqMessage[];

  const messages: GroqMessage[] = [
    {
      role: "system",
      content:
        "You are Zero AI, a personal finance assistant. Use the provided user data only. Be practical, concise, and actionable. Keep continuity with prior conversation context. When giving advice, include numbers and clear next steps.",
    },
    {
      role: "user",
      content: `User finance data JSON:\n${JSON.stringify(context)}`,
    },
    ...recentConversation,
    {
      role: "user",
      content: `Latest user request: ${params.question}\n\nRespond with continuity from previous messages and data-aware insights.`,
    },
  ];

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_tokens: 500,
      messages,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Groq empty response");
  return content;
}
