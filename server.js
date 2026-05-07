import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";
const NITTER_RSS_SOURCES = [
  "https://nitter.poast.org",
  "https://nitter.privacydev.net",
  "https://nitter.esmailelbob.xyz",
];
const SOMALILAND_TERMS = ["somaliland", "hargeisa", "berbera", "borama"];
const FALLBACK_NEWS_KEY = "g-UpSttv40RqUFUc877PGn7mLj4Xof8PlcZZuCTr-hbh4l7P";
const X_QUERY_VARIANTS = [
  "Somaliland OR Hargeisa OR Berbera OR Borama",
  "#Somaliland OR Somaliland news",
  "Somaliland politics OR Somaliland economy OR Somaliland government",
];
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:zero@example.com";
const WEB_PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
const pushSubscriptions = new Map();
const scheduledPushJobs = new Set();
const MAX_QUESTION_LENGTH = 800;
const MAX_CHAT_ITEMS = 12;
const MAX_CHAT_TEXT_LENGTH = 800;
const MAX_CONTEXT_DEPTH = 5;
const MAX_CONTEXT_KEYS = 120;
const MAX_CONTEXT_ARRAY_ITEMS = 120;
const MAX_CONTEXT_STRING_LENGTH = 500;

app.use(express.json({ limit: "1mb" }));

if (WEB_PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function decodeXmlEntities(input) {
  return String(input)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractTag(itemXml, tag) {
  const match = itemXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!match) return "";
  return decodeXmlEntities(match[1]).trim();
}

function parseRssItems(xml) {
  const chunks = String(xml).match(/<item>([\s\S]*?)<\/item>/gi) || [];
  return chunks.map((chunk) => {
    const title = extractTag(chunk, "title");
    const url = extractTag(chunk, "link");
    const description = extractTag(chunk, "description");
    const publishedAt = extractTag(chunk, "pubDate");
    return {
      title: title || "X post",
      description: description || "No summary available.",
      url,
      source: "X (Twitter)",
      publishedAt,
    };
  }).filter((item) => item.url);
}

function isSomalilandRelevant(item) {
  const blob = `${item.title} ${item.description} ${item.source}`.toLowerCase();
  return SOMALILAND_TERMS.some((term) => blob.includes(term));
}

function dedupeNews(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item.url || item.title).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchXBriefItems(queries) {
  const collected = [];
  for (const query of queries) {
    const encodedQuery = encodeURIComponent(query);
    for (const base of NITTER_RSS_SOURCES) {
      try {
        const rssUrl = `${base}/search/rss?f=tweets&q=${encodedQuery}`;
        const response = await fetch(rssUrl, {
          headers: { "User-Agent": "Mozilla/5.0 ZeroApp/1.0" },
        });
        if (!response.ok) continue;
        const xml = await response.text();
        const items = parseRssItems(xml)
          .map((item) => ({ ...item, source: "X (Twitter)" }))
          .filter(isSomalilandRelevant);
        collected.push(...items);
        if (collected.length >= 8) {
          return dedupeNews(collected);
        }
      } catch {
        // continue with next mirror
      }
    }
  }
  return dedupeNews(collected);
}

app.get("/api/x-brief", async (req, res) => {
  const items = await fetchXBriefItems(X_QUERY_VARIANTS);
  return res.status(200).json({ items: items.slice(0, 5) });
});

app.get("/api/news-brief", async (req, res) => {
  try {
    const items = dedupeNews(await fetchXBriefItems(X_QUERY_VARIANTS));
    return res.status(200).json({ items: items.slice(0, 5) });
  } catch {
    return res.status(200).json({ items: [] });
  }
});

function serializePushError(error) {
  if (!error || typeof error !== "object") return "Unknown web-push error";
  const statusCode = "statusCode" in error ? error.statusCode : undefined;
  const body = "body" in error ? error.body : undefined;
  const message = "message" in error ? error.message : "Web-push error";
  return `${statusCode ?? "n/a"} ${message}${body ? ` - ${String(body).slice(0, 200)}` : ""}`;
}

async function sendPushToSubscription(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (error) {
    const statusCode = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
    if (statusCode === 404 || statusCode === 410) {
      pushSubscriptions.delete(subscription.endpoint);
      return { ok: false, removed: true, detail: "Expired subscription removed" };
    }
    return { ok: false, detail: serializePushError(error) };
  }
}

function sanitizeQuestion(input) {
  if (typeof input !== "string") return "";
  return input.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_LENGTH);
}

function sanitizeChatHistory(input) {
  if (!Array.isArray(input)) return [];
  return input
    .slice(-MAX_CHAT_ITEMS)
    .map((entry) => {
      const role = entry?.role === "assistant" ? "assistant" : "user";
      const text = typeof entry?.text === "string"
        ? entry.text.replace(/\s+/g, " ").trim().slice(0, MAX_CHAT_TEXT_LENGTH)
        : "";
      return { role, text };
    })
    .filter((entry) => entry.text.length > 0);
}

function sanitizeContext(value, depth = 0, keyBudget = { left: MAX_CONTEXT_KEYS }) {
  if (depth > MAX_CONTEXT_DEPTH) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, MAX_CONTEXT_STRING_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CONTEXT_ARRAY_ITEMS)
      .map((item) => sanitizeContext(item, depth + 1, keyBudget))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (keyBudget.left <= 0) break;
    keyBudget.left -= 1;
    const cleaned = sanitizeContext(nested, depth + 1, keyBudget);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

app.get("/api/push/public-key", (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  return res.status(200).json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", async (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const subscription = req.body?.subscription;
  if (!subscription || typeof subscription.endpoint !== "string") {
    return res.status(400).json({ error: "Missing valid subscription object" });
  }
  pushSubscriptions.set(subscription.endpoint, subscription);

  const displayName = String(req.body?.displayName || "there").trim() || "there";
  const upcomingCount = Number(req.body?.upcomingCount || 0);
  const firstPayload = {
    title: "Coach Zero connected",
    body: upcomingCount > 0
      ? `Hi ${displayName}, notifications are live. ${upcomingCount} bill(s) are coming up.`
      : `Hi ${displayName}, notifications are live. I will keep your day and money on track.`,
    url: "/",
    tag: "zero-connected",
  };
  const sent = await sendPushToSubscription(subscription, firstPayload);
  return res.status(200).json({ ok: true, sent });
});

app.post("/api/save-subscription", async (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const subscription = req.body?.subscription ?? req.body;
  if (!subscription || typeof subscription.endpoint !== "string") {
    return res.status(400).json({ error: "Missing valid subscription object" });
  }
  pushSubscriptions.set(subscription.endpoint, subscription);
  return res.status(200).json({ ok: true, total: pushSubscriptions.size });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const endpoint = String(req.body?.endpoint || "");
  if (!endpoint) {
    return res.status(400).json({ error: "Missing endpoint" });
  }
  pushSubscriptions.delete(endpoint);
  return res.status(200).json({ ok: true });
});

app.post("/api/push/test", async (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const displayName = String(req.body?.displayName || "there").trim() || "there";
  const upcomingCount = Number(req.body?.upcomingCount || 0);
  const payload = {
    title: "Zero reminder",
    body: upcomingCount > 0
      ? `Hi ${displayName}, you have ${upcomingCount} upcoming bill(s). Open Zero now.`
      : `Hi ${displayName}, quick check-in: review your spending and routine blocks.`,
    url: "/",
    tag: "zero-test",
  };
  const targets = [...pushSubscriptions.values()];
  if (targets.length === 0) {
    return res.status(404).json({ error: "No active push subscriptions yet" });
  }
  const results = await Promise.all(targets.map((sub) => sendPushToSubscription(sub, payload)));
  return res.status(200).json({
    ok: true,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
});

app.post("/api/send-notification", async (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || "").trim();
  const displayName = String(req.body?.displayName || "").trim();
  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required" });
  }
  const personalizedBody = displayName ? `Hi ${displayName}, ${body}` : body;
  const payload = { title, body: personalizedBody, icon: "/icon.svg", url: "/" };
  const targets = [...pushSubscriptions.values()];
  if (targets.length === 0) {
    return res.status(404).json({ error: "No active push subscriptions yet" });
  }
  const results = await Promise.all(targets.map((sub) => sendPushToSubscription(sub, payload)));
  return res.status(200).json({
    ok: true,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
});

app.post("/api/schedule-notification", (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || "").trim();
  const displayName = String(req.body?.displayName || "").trim();
  const delaySeconds = Number(req.body?.delaySeconds || 0);
  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required" });
  }
  if (!Number.isFinite(delaySeconds) || delaySeconds < 1) {
    return res.status(400).json({ error: "delaySeconds must be >= 1" });
  }
  const targets = [...pushSubscriptions.values()];
  if (targets.length === 0) {
    return res.status(404).json({ error: "No active push subscriptions yet" });
  }
  const personalizedBody = displayName ? `Hi ${displayName}, ${body}` : body;
  const payload = { title, body: personalizedBody, icon: "/icon.svg", url: "/" };
  const timeoutId = setTimeout(async () => {
    try {
      await Promise.all(targets.map((sub) => sendPushToSubscription(sub, payload)));
    } finally {
      scheduledPushJobs.delete(timeoutId);
    }
  }, Math.floor(delaySeconds * 1000));
  scheduledPushJobs.add(timeoutId);
  return res.status(200).json({ ok: true, scheduledInSeconds: Math.floor(delaySeconds) });
});

app.post("/api/groq", async (req, res) => {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing GROQ_API_KEY" });
  }

  try {
    const body = req.body ?? {};
    const question = sanitizeQuestion(body.question);
    const chatHistory = sanitizeChatHistory(body.chatHistory);
    const context = sanitizeContext(body.context ?? {});
    const stream = Boolean(body.stream);

    if (!question.trim()) {
      return res.status(400).json({ error: "Missing question" });
    }

    const systemPrompt = [
      "You are Coach Zero: calm, direct, encouraging, and human, like a smart friend who knows this user's money and routine.",
      "Use the provided profile, finance, tasks, meals, and time-of-day context in every reply.",
      "",
      "## Routine Context",
      String(context?.routineContextSummary || "Routine context unavailable."),
      "",
      "Core rules:",
      "1) Use only provided data; never invent balances, transactions, dates, subscriptions, income, or events.",
      "2) Treat financeSnapshot as highest-priority source of truth when present.",
      "3) Never confuse financeSnapshot.currentBalance (cash now) with financeSnapshot.monthlySalary (planned monthly income).",
      "4) Keep responses short and punchy by default; go longer only when the question requires depth.",
      "5) Use casual natural language, contractions, and occasional light humor.",
      "6) Never use bullet points or formal corporate language unless the user explicitly asks for it.",
      "7) Remember the conversation context and reference it naturally when relevant.",
      "8) Occasionally ask one follow-up question to keep momentum, but not on every turn.",
      "9) If data is insufficient or ambiguous, ask one specific clarifying question instead of guessing.",
      "10) If user asks what to do now, answer from the current timeline block first.",
      "11) If it is late and checklist completion is low, mention it proactively and suggest a realistic next step.",
      "12) If routine template is empty, suggest setting up a simple template.",
      "13) Cross-reference routine and finance context when useful (e.g., bills due + no admin block).",
      "",
      "Style constraints:",
      "- No raw JSON, no long lists, no generic disclaimers.",
      "- Prefer short sentences, exact numbers, and concrete next actions.",
      "- If prior chat exists, maintain continuity with it.",
    ].join("\n");

    const messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: `User finance data JSON:\n${JSON.stringify(context)}`,
      },
      ...chatHistory.slice(-10).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.text ?? ""),
      })),
      {
        role: "user",
        content: `Latest user request: ${question}\n\nInfer user intent first, then answer with concise reasoning and concrete numbers. Ask a follow-up only when needed for accuracy.`,
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
        stream,
        messages,
      }),
    });

    if (!stream) {
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
    }

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      return res.status(response.status || 502).json({
        error: "Groq request failed",
        detail: data?.error?.message || data?.error || "Unknown error",
      });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const piece = json?.choices?.[0]?.delta?.content;
          if (typeof piece === "string" && piece.length > 0) {
            res.write(piece);
          }
        } catch {
          // ignore malformed stream events
        }
      }
    }
    return res.end();
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
