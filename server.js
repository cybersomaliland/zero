import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";
import cron from "node-cron";
import { differenceInCalendarDays, parseISO } from "date-fns";

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
const scheduledPushJobs = new Map();
const lastNotificationVariantByType = new Map();
const latestNotificationContext = {
  finance: { todayRemaining: 0, dailyAllowance: 0, savePerDay: 0, overBy: 0 },
  tasks: [],
  subscriptions: [],
  routine: { currentBlock: "", nextBlock: "", nextBlockTime: "" },
  badge: { billsDueThisWeek: 0, highPriorityOpenTasks: 0, overBudgetDays: 0 },
  pushNotificationMessages: {},
};
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
  const relevant = [];
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
        const items = parseRssItems(xml).map((item) => ({ ...item, source: "X (Twitter)" }));
        const topical = items.filter(isSomalilandRelevant);
        relevant.push(...topical);
        collected.push(...items);
        if (relevant.length >= 5) {
          return dedupeNews(relevant);
        }
        if (collected.length >= 12) {
          return dedupeNews(relevant.length > 0 ? relevant : collected);
        }
      } catch {
        // continue with next mirror
      }
    }
  }
  return dedupeNews(relevant.length > 0 ? relevant : collected);
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

const FORBIDDEN_WORDS = /\b(hi there|reminder|kindly|please|open zero|notification|alert)\b/gi;

function trimWords(input, maxWords) {
  return String(input).replace(/\s+/g, " ").trim().split(" ").slice(0, maxWords).join(" ").trim();
}

function compactLabel(input, fallback = "Bill") {
  const safe = String(input || "").replace(/[^\w\s&.-]/g, "").trim();
  if (!safe) return fallback;
  return trimWords(safe, 3);
}

function amountText(value) {
  const num = Number(value || 0);
  return `$${Math.abs(num).toFixed(2)}`;
}

function interpolateTemplate(template, data) {
  return String(template).replace(/\[([A-Za-z]+)\]/g, (_, key) => {
    const val = data?.[key];
    return val === undefined || val === null ? "" : String(val);
  });
}

const PUSH_MESSAGE_KEYS = new Set([
  "bill_due_tomorrow",
  "bill_due_today",
  "over_budget",
  "daily_allowance_morning",
  "savings",
  "task_still_open",
  "morning_briefing",
  "streak_protect",
  "custom",
]);

function sanitizePushNotificationMessages(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, val] of Object.entries(raw)) {
    if (!PUSH_MESSAGE_KEYS.has(key)) continue;
    if (!val || typeof val !== "object") continue;
    const title = typeof val.title === "string" ? val.title.trim().slice(0, 120) : "";
    const body = typeof val.body === "string" ? val.body.trim().slice(0, 600) : "";
    if (!title && !body) continue;
    out[key] = {};
    if (title) out[key].title = title;
    if (body) out[key].body = body;
  }
  return out;
}

function getPushCopyOverride(type) {
  const map = latestNotificationContext.pushNotificationMessages;
  if (!map || typeof map !== "object") return null;
  const row = map[type];
  if (!row || typeof row !== "object") return null;
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const body = typeof row.body === "string" ? row.body.trim() : "";
  if (!title && !body) return null;
  return { title: title || null, body: body || null };
}

function pickTemplate(type, templates) {
  if (!Array.isArray(templates) || templates.length === 0) return "";
  let idx = Math.floor(Math.random() * templates.length);
  const last = lastNotificationVariantByType.get(type);
  if (templates.length > 1 && idx === last) {
    idx = (idx + 1 + Math.floor(Math.random() * (templates.length - 1))) % templates.length;
  }
  lastNotificationVariantByType.set(type, idx);
  return templates[idx];
}

function buildNotification(type, data = {}) {
  const bill = compactLabel(data.bill || data.billName, "Bill");
  const task = compactLabel(data.task || data.taskName, "Task");
  const amount = amountText(data.amount || data.todayAmount || data.saveAmount || data.overBy || 0);
  const day = Number(data.day || data.dayIndex || 1);
  const tasksCount = Number(data.tasksCount || data.openTasks || 0);
  const block = compactLabel(data.block || data.nextBlock || "Focus block", "Focus block");
  const time = String(data.time || data.nextBlockTime || "9:00").trim() || "9:00";
  const streakDaysVal = Number(data.streakDays ?? data.day ?? 0);
  const interpPayload = {
    Bill: bill,
    amount,
    task,
    X: String(type === "streak_protect" ? Math.max(1, streakDaysVal || 1) : day || tasksCount || 1),
    block,
    time,
    message: String(data.message || ""),
  };

  const variants = {
    bill_due_tomorrow: [
      "[Bill] is coming for [amount] tomorrow",
      "Tomorrow: [Bill] takes [amount]. Just so you know.",
      "[amount] out tomorrow — [Bill] doesn't forget",
      "One day left before [Bill] charges you",
    ],
    bill_due_today: [
      "[Bill] hits today. [amount] gone.",
      "Today's the day — [amount] to [Bill]",
      "⚠️ [Bill] charges today. [amount].",
      "It's happening today. [amount] · [Bill]",
    ],
    over_budget: [
      "You've passed your limit. Rest is tomorrow's money.",
      "Today's gone over. [amount] into tomorrow's allowance.",
      "Slightly over — [amount] past today's limit",
      "Past the line today. Tomorrow, tighter.",
    ],
    daily_allowance_morning: [
      "☀️ [amount] to work with today. Make it count.",
      "New day. [amount] on the clock.",
      "Today's budget is live. [amount] — go easy.",
      "Morning. You've got [amount] for today.",
    ],
    savings: [
      "Day [X] of 3. [amount] saved today keeps the plan alive.",
      "Save [amount] today. You're close to the buffer.",
      "One save away from a good week.",
      "[amount] today. That's all.",
    ],
    task_still_open: [
      "Still open: [task]. You got this.",
      "[task] — still on the list. Quick win?",
      "This one's been waiting: [task]",
      "Haven't touched [task] yet today.",
    ],
    morning_briefing: [
      "☀️ [X] tasks, [amount] today, [block] at [time]",
      "Morning. [X] tasks · [amount] · [block] at [time]",
      "Day's ready. [X] things to do, [amount] to spend.",
      "You've got [X] tasks and [amount]. Let's go.",
    ],
    streak_protect: [
      "[X]-day streak — log spend or Routine tonight.",
      "Protect [X] days — one tiny log saves the chain.",
      "Streak [X] — touch Routine or Activity before midnight.",
    ],
    custom: ["[message]"],
  };

  const titles = {
    bill_due_tomorrow: bill,
    bill_due_today: bill,
    over_budget: "Budget line",
    daily_allowance_morning: "Today budget",
    savings: "Savings pulse",
    task_still_open: task,
    morning_briefing: "Morning pulse",
    streak_protect: "Streak protection",
    custom: compactLabel(data.title, "Update"),
  };

  const override = getPushCopyOverride(type);
  const template = override?.body
    ? override.body.slice(0, 600)
    : pickTemplate(type, variants[type] || variants.custom);
  const bodyRaw = interpolateTemplate(template, interpPayload).replace(FORBIDDEN_WORDS, "").trim();

  let title;
  if (override?.title) {
    title = trimWords(
      interpolateTemplate(override.title.slice(0, 120), interpPayload).replace(FORBIDDEN_WORDS, "").trim(),
      8,
    );
  } else {
    title = trimWords(String(titles[type] || "Update").replace(FORBIDDEN_WORDS, ""), 5);
  }
  const body = trimWords(bodyRaw, 10);

  return {
    title: title || "Update",
    body: body || "Data updated.",
    url: "/",
    tag: `zero-${type}`,
  };
}

function totalBadgeCountFromContext() {
  const b = latestNotificationContext.badge;
  if (!b || typeof b !== "object") return 0;
  const bills = Number(b.billsDueThisWeek) || 0;
  const openHigh = Number(b.highPriorityOpenTasks) || 0;
  const overDays = Number(b.overBudgetDays) || 0;
  return Math.max(0, Math.round(bills) + Math.round(openHigh) + Math.round(overDays));
}

async function sendPushToSubscription(subscription, payload) {
  try {
    const badgeCount = totalBadgeCountFromContext();
    const body =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload, badgeCount }
        : payload;
    await webpush.sendNotification(subscription, JSON.stringify(body));
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

async function broadcastPush(payload) {
  const targets = [...pushSubscriptions.values()];
  if (targets.length === 0) return { ok: false, sent: 0, failed: 0 };
  const results = await Promise.all(targets.map((sub) => sendPushToSubscription(sub, payload)));
  return {
    ok: true,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
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

  const firstPayload = buildNotification("custom", { title: "Zero ready", message: "Push channel connected." });
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
  if (pushSubscriptions.size === 0) {
    return res.status(404).json({ error: "No active push subscriptions yet" });
  }
  const payload = buildNotification("morning_briefing", {
    tasksCount: Number(req.body?.tasksCount || latestNotificationContext.tasks.length || 0),
    amount: Number(req.body?.amount ?? latestNotificationContext.finance?.todayRemaining ?? 0),
    block: req.body?.block || latestNotificationContext.routine?.nextBlock || "Focus",
    time: req.body?.time || latestNotificationContext.routine?.nextBlockTime || "9:00",
  });
  const result = await broadcastPush(payload);
  return res.status(200).json(result);
});

app.post("/api/notification-context", (req, res) => {
  const incoming = req.body || {};
  if (incoming.finance && typeof incoming.finance === "object") {
    latestNotificationContext.finance = { ...latestNotificationContext.finance, ...incoming.finance };
  }
  if (Array.isArray(incoming.tasks)) latestNotificationContext.tasks = incoming.tasks.slice(0, 50);
  if (Array.isArray(incoming.subscriptions)) latestNotificationContext.subscriptions = incoming.subscriptions.slice(0, 100);
  if (incoming.routine && typeof incoming.routine === "object") {
    latestNotificationContext.routine = { ...latestNotificationContext.routine, ...incoming.routine };
  }
  if (incoming.badge && typeof incoming.badge === "object") {
    latestNotificationContext.badge = {
      billsDueThisWeek: Math.max(0, Math.round(Number(incoming.badge.billsDueThisWeek) || 0)),
      highPriorityOpenTasks: Math.max(0, Math.round(Number(incoming.badge.highPriorityOpenTasks) || 0)),
      overBudgetDays: Math.max(0, Math.round(Number(incoming.badge.overBudgetDays) || 0)),
    };
  }
  if (incoming.pushNotificationMessages !== undefined) {
    latestNotificationContext.pushNotificationMessages = sanitizePushNotificationMessages(
      incoming.pushNotificationMessages,
    );
  }
  return res.status(200).json({ ok: true });
});

app.post("/api/send-notification", async (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const type = String(req.body?.type || "custom").trim();
  const payload = buildNotification(type, req.body?.data || {});
  const result = await broadcastPush(payload);
  if (!result.ok) return res.status(404).json({ error: "No active push subscriptions yet" });
  return res.status(200).json(result);
});

app.post("/api/schedule-notification", (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const type = String(req.body?.type || "").trim();
  const data = req.body?.data || {};
  const delayMs = Number(req.body?.delayMs || 0);
  if (!type) {
    return res.status(400).json({ error: "type is required" });
  }
  if (!Number.isFinite(delayMs) || delayMs < 1) {
    return res.status(400).json({ error: "delayMs must be >= 1" });
  }

  const timeoutId = setTimeout(async () => {
    try {
      const payload = buildNotification(type, data);
      await broadcastPush(payload);
    } finally {
      scheduledPushJobs.delete(String(timeoutId));
    }
  }, Math.floor(delayMs));
  scheduledPushJobs.set(String(timeoutId), timeoutId);
  return res.status(200).json({ ok: true, type, scheduledInMs: Math.floor(delayMs) });
});

app.post("/api/spending-update", async (req, res) => {
  if (!WEB_PUSH_ENABLED) {
    return res.status(503).json({ error: "Web push disabled. Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY." });
  }
  const todayRemaining = Number(req.body?.todayRemaining ?? latestNotificationContext.finance.todayRemaining ?? 0);
  const overBy = Math.max(0, Number(req.body?.overBy ?? Math.abs(Math.min(0, todayRemaining))));
  latestNotificationContext.finance.todayRemaining = todayRemaining;
  latestNotificationContext.finance.overBy = overBy;
  if (todayRemaining >= 0) {
    return res.status(200).json({ ok: true, triggered: false });
  }
  const payload = buildNotification("over_budget", { amount: overBy });
  const result = await broadcastPush(payload);
  return res.status(200).json({ ok: true, triggered: true, ...result });
});

function dueInDays(isoDate) {
  return differenceInCalendarDays(parseISO(isoDate), new Date());
}

async function runMorningBriefingJob() {
  const data = latestNotificationContext;
  const openTasks = Array.isArray(data.tasks) ? data.tasks.filter((t) => !t.done) : [];
  const payload = buildNotification("morning_briefing", {
    tasksCount: openTasks.length,
    amount: Number(data.finance?.todayRemaining ?? data.finance?.dailyAllowance ?? 0),
    block: data.routine?.nextBlock || data.routine?.currentBlock || "Focus",
    time: data.routine?.nextBlockTime || "9:00",
  });
  await broadcastPush(payload);
}

async function runDailyAllowanceJob() {
  const payload = buildNotification("daily_allowance_morning", {
    amount: Number(latestNotificationContext.finance?.dailyAllowance ?? 0),
  });
  await broadcastPush(payload);
}

async function runBillCheckerJob() {
  const subs = Array.isArray(latestNotificationContext.subscriptions) ? latestNotificationContext.subscriptions : [];
  for (const sub of subs) {
    const dueDays = dueInDays(sub.nextBillingDate || sub.dueDate || "");
    if (dueDays === 0) {
      await broadcastPush(buildNotification("bill_due_today", { bill: sub.name, amount: sub.amount }));
    } else if (dueDays === 1) {
      await broadcastPush(buildNotification("bill_due_tomorrow", { bill: sub.name, amount: sub.amount }));
    }
  }
}

async function runOpenTaskJob() {
  const openTasks = Array.isArray(latestNotificationContext.tasks) ? latestNotificationContext.tasks.filter((t) => !t.done) : [];
  if (openTasks.length === 0) return;
  await broadcastPush(buildNotification("task_still_open", { task: openTasks[0]?.title || "Task" }));
}

if (WEB_PUSH_ENABLED) {
  cron.schedule("0 7 * * *", () => { void runMorningBriefingJob(); });
  cron.schedule("0 8 * * *", () => { void runDailyAllowanceJob(); });
  cron.schedule("0 9 * * *", () => { void runBillCheckerJob(); });
  cron.schedule("0 15 * * *", () => { void runOpenTaskJob(); });
}

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
      "## Machine actions (when user asks to add / schedule / log / complete / plan)",
      "If they want you to CHANGE THE APP (new calendar block, checklist task, transaction, plan-ahead row, full-day schedule, mark tasks done), keep your normal reply first, then append EXACTLY one block:",
      "",
      "<<<ZERO_ACTIONS>>>",
      '{"version":1,"actions":[ ... ]}',
      "<<<END_ZERO_ACTIONS>>>",
      "",
      "Equivalent formats also work: raw JSON array [{\"type\":\"add_task\",...}] or {\"action\":{single}}, or {\"steps\":[...]}. Prefer {\"version\":1,\"actions\":[...]}.",
      "",
      "JSON rules: valid JSON only inside markers (optional ```json fences). Max ~18 actions. Never duplicate this JSON outside the markers.",
      "",
      "Allowed action objects (examples — use real values):",
      '- {"type":"clear_timeline_for_date","date":"yyyy-MM-dd"} — optional before rebuilding a day.',
      '- {"type":"set_day_timeline","date":"yyyy-MM-dd","blocks":[{"title":"Deep work","hour":9,"startMinute":0,"durationMinutes":90,"category":"work"}]} — replaces ALL blocks that day (category: work|health|personal).',
      '- {"type":"add_timeline_block","title":"Walk","hour":12,"startMinute":30,"durationMinutes":45,"category":"health","date":"yyyy-MM-dd"} — date optional (defaults to today in app).',
      '- {"type":"add_task","title":"Call bank","priority":"high|medium|low","category":"work|health|personal"}',
      '- {"type":"complete_tasks","titles":["substring"]} OR {"type":"complete_tasks","match_all_open":true} — only match_all_open when user clearly asked to complete everything.',
      '- {"type":"add_transaction","amount":12.5,"tx_type":"expense|income","category":"Food & Drink","note":"coffee","date":"yyyy-MM-dd"} — date optional; category must match app categories when possible.',
      '- {"type":"add_plan_ahead","date":"yyyy-MM-dd","title":"Dentist","hour":15,"category":"health"}',
      "",
      "Planning a whole day: combine clear_timeline_for_date + set_day_timeline + add_task + optionally add_transaction for planned spends the user agreed to. Tie suggested spends to financeSnapshot.todayRemaining and dailyAllowance; never invent large purchases without clear user intent.",
      "",
      "Style constraints:",
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
        max_tokens: 1400,
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
