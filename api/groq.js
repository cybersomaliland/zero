const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing GROQ_API_KEY" });
  }

  try {
    const body = req.body ?? {};
    const question = typeof body.question === "string" ? body.question : "";
    const chatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : [];
    const context = body.context ?? {};

    if (!question.trim()) {
      return res.status(400).json({ error: "Missing question" });
    }

    const messages = [
      {
        role: "system",
        content:
          "You are Zero AI, a personal finance assistant. Use the provided user data only. Be practical, concise, and actionable. Keep continuity with prior conversation context. When giving advice, include numbers and clear next steps.",
      },
      {
        role: "user",
        content: `User finance data JSON:\n${JSON.stringify(context)}`,
      },
      ...chatHistory.slice(-12).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.text ?? ""),
      })),
      {
        role: "user",
        content: `Latest user request: ${question}\n\nRespond with continuity from previous messages and data-aware insights.`,
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
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: "Groq request failed",
        detail: data?.error?.message || data?.error || "Unknown error",
      });
    }

    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return res.status(502).json({ error: "Groq returned empty content" });
    }

    return res.status(200).json({ answer: content });
  } catch (error) {
    return res.status(500).json({
      error: "Proxy request failed",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
