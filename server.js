import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

app.use(express.json({ limit: "1mb" }));

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
  const query = "Somaliland OR Hargeisa OR Berbera OR Borama";
  const encodedQuery = encodeURIComponent(query);
  const newsKey = process.env.NEWS_API_KEY || process.env.VITE_NEWS_API_KEY || FALLBACK_NEWS_KEY;
  const attempts = [
    async () => {
      return fetchXBriefItems(X_QUERY_VARIANTS);
    },
    async () => {
      const rssUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`;
      const response = await fetch(rssUrl, { headers: { "User-Agent": "Mozilla/5.0 ZeroApp/1.0" } });
      if (!response.ok) throw new Error(`Google News RSS failed: ${response.status}`);
      const xml = await response.text();
      return parseRssItems(xml)
        .map((item) => ({ ...item, source: "Google News" }))
        .filter(isSomalilandRelevant);
    },
    async () => {
      const url = `https://api.thenewsapi.com/v1/news/top?api_token=${encodeURIComponent(newsKey)}&search=${encodedQuery}&language=en&limit=10`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TheNewsAPI failed: ${response.status}`);
      const data = await response.json();
      return (data.data || [])
        .filter((a) => a?.title && a?.url)
        .map((a) => ({
          title: a.title,
          description: String(a.description || "No summary available."),
          url: a.url,
          source: a.source || "Somaliland News",
          publishedAt: a.published_at,
        }))
        .filter(isSomalilandRelevant);
    },
  ];

  for (const attempt of attempts) {
    try {
      const items = dedupeNews(await attempt());
      if (items.length > 0) {
        return res.status(200).json({ items: items.slice(0, 5) });
      }
    } catch {
      // try next provider
    }
  }

  return res.status(200).json({ items: [] });
});

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
