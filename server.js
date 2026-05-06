import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

app.use(express.json({ limit: "1mb" }));

app.post("/api/groq", async (req, res) => {
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
          "You are Zero AI, a personal finance assistant. Use the provided user data only. First infer the exact user intent, then answer with the most relevant numbers. Be concise and practical. Keep responses short (max 4 lines). Always personalize by using financeSnapshot as source of truth when available. IMPORTANT: financeSnapshot.currentBalance is real account balance now, while financeSnapshot.monthlySalary is planned monthly income. Never confuse them. If the request is ambiguous or missing a key amount/date, ask one precise clarifying question instead of guessing. Never dump raw JSON or full datasets. End every answer with exactly one useful follow-up question.",
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
        content: `Latest user request: ${question}\n\nRespond with continuity from previous messages, short personalized advice, and one follow-up question.`,
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
});

app.use(express.static(path.join(__dirname, "dist")));
app.get(/.*/, (_, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Zero server listening on port ${PORT}`);
});
