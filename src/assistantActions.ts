import { format, parseISO } from "date-fns";
import { CATEGORY_NAMES, getCategoryDefinition } from "./categories";
import { db } from "./db";
import type {
  PlannedCashflowKind,
  RecurringIncomeCycle,
  Settings,
  SubscriptionCycle,
  TxType,
} from "./types";

export const ZERO_ACTIONS_OPEN = "<<<ZERO_ACTIONS>>>";
export const ZERO_ACTIONS_CLOSE = "<<<END_ZERO_ACTIONS>>>";

const MAX_ACTIONS = 18;
const MAX_BLOCK_DURATION = 8 * 60;
const MAX_TX_AMOUNT = 500_000;

export type AssistantExecutors<TimelineEvent, Task extends { id: number; title: string; done: boolean }> = {
  todayKey: string;
  setTimelineEvents: (updater: (prev: TimelineEvent[]) => TimelineEvent[]) => void;
  setTasks: (updater: (prev: Task[]) => Task[]) => void;
  getTransactions: () => Array<{
    id?: number;
    amount: number;
    type: TxType;
    category: string;
    note?: string;
    date: string;
  }>;
  addTransaction: (row: {
    amount: number;
    type: "expense" | "income";
    category?: string;
    note?: string;
    date: string;
  }) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  addSubscription: (row: {
    name: string;
    amount: number;
    cycle: SubscriptionCycle;
    nextBillingDate: string;
  }) => Promise<void>;
  addRecurringIncome: (row: {
    name: string;
    amount: number;
    cycle: RecurringIncomeCycle;
    nextDate: string;
  }) => Promise<void>;
  addPlannedCashflow: (row: {
    title: string;
    amount: number;
    kind: PlannedCashflowKind;
    date: string;
    category?: string;
  }) => Promise<void>;
  updateSettings: (row: Partial<Settings>) => Promise<void>;
  reloadPlanAhead: () => Promise<void>;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function isIsoDay(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normalizeRoutineCat(raw: unknown): "work" | "health" | "personal" | null {
  if (raw === "work" || raw === "health" || raw === "personal") return raw;
  return null;
}

function normalizePriority(raw: unknown): "high" | "medium" | "low" {
  if (raw === "high" || raw === "low") return raw;
  return "medium";
}

function normalizeSubscriptionCycle(raw: unknown): SubscriptionCycle | null {
  if (raw === "weekly" || raw === "monthly" || raw === "yearly") return raw;
  return null;
}

function normalizeRecurringIncomeCycle(raw: unknown): RecurringIncomeCycle | null {
  if (raw === "weekly" || raw === "biweekly" || raw === "monthly") return raw;
  return null;
}

function normalizePlannedCashflowKind(raw: unknown): PlannedCashflowKind | null {
  if (raw === "planned_expense" || raw === "savings_transfer") return raw;
  return null;
}

function pickTxCategory(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (!t) return "General";
  const exact = CATEGORY_NAMES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const embed = CATEGORY_NAMES.find(
    (c) =>
      c.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(c.toLowerCase()),
  );
  return embed ?? getCategoryDefinition(t).name;
}

function asIsoDayOrToday(raw: unknown, todayKey: string) {
  return isIsoDay(raw) ? raw : todayKey;
}

export function stripActionMarkers(fullText: string): { visible: string; actionsJson: string | null } {
  const i = fullText.indexOf(ZERO_ACTIONS_OPEN);
  const j = fullText.indexOf(ZERO_ACTIONS_CLOSE);
  if (i === -1 || j === -1 || j <= i) {
    return { visible: fullText.trim(), actionsJson: null };
  }
  const visible = `${fullText.slice(0, i).trim()}${fullText.slice(j + ZERO_ACTIONS_CLOSE.length).trim()}`.trim();
  const actionsJson = fullText.slice(i + ZERO_ACTIONS_OPEN.length, j).trim();
  return { visible, actionsJson };
}

/** Visible reply text while streaming (hide JSON block once marker starts). */
export function streamedVisibleReply(soFar: string): string {
  const cut = soFar.indexOf(ZERO_ACTIONS_OPEN);
  if (cut === -1) return soFar;
  return soFar.slice(0, cut).trimEnd();
}

/** Strip markdown fences Groq sometimes wraps inside markers. */
export function sanitizeActionsMarkerBody(raw: string): string {
  let s = raw.trim();
  const openFence = /^```(?:json)?\s*/i;
  if (openFence.test(s)) {
    s = s.replace(openFence, "").replace(/\s*```\s*$/i, "").trim();
  }
  return s;
}

/** Accept several shapes models emit instead of strict `{ actions: [...] }`. */
export function extractActionsList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const arrayKeys = ["actions", "steps", "operations", "commands", "tool_calls", "toolCalls"];
  for (const k of arrayKeys) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  if (o.action && typeof o.action === "object" && !Array.isArray(o.action)) {
    return [o.action];
  }
  if (typeof o.type === "string") {
    return [payload];
  }
  return null;
}

export async function executeAssistantPayload<
  TimelineEvent extends {
    id: number;
    title: string;
    hour: number;
    startMinute?: number;
    durationMinutes?: number;
    category: string;
    date?: string;
  },
  Task extends { id: number; title: string; priority: string; category: string; done: boolean },
>(
  payload: unknown,
  exec: AssistantExecutors<TimelineEvent, Task>,
): Promise<{ applied: string[]; errors: string[] }> {
  const applied: string[] = [];
  const errors: string[] = [];
  const actionsUnknown = extractActionsList(payload);
  if (!actionsUnknown) {
    errors.push(
      'No actions found. Use {"version":1,"actions":[{...}]} or a raw JSON array of objects like [{"type":"add_task",...}].',
    );
    return { applied, errors };
  }
  const actions = actionsUnknown.slice(0, MAX_ACTIONS);

  for (const raw of actions) {
    if (!raw || typeof raw !== "object") continue;
    const act = raw as Record<string, unknown>;
    const type = String(act.type ?? "");

    try {
      if (type === "clear_timeline_for_date") {
        const date = act.date;
        if (!isIsoDay(date)) {
          errors.push("clear_timeline_for_date: bad date.");
          continue;
        }
        exec.setTimelineEvents((prev) =>
          prev.filter((e) => (e.date ?? exec.todayKey) !== date) as TimelineEvent[],
        );
        applied.push(`Cleared timeline for ${date}.`);
        continue;
      }

      if (type === "set_day_timeline") {
        const date = act.date;
        const blocks = act.blocks;
        if (!isIsoDay(date) || !Array.isArray(blocks)) {
          errors.push("set_day_timeline: bad date or blocks.");
          continue;
        }
        const mapped: TimelineEvent[] = [];
        const slice = blocks.slice(0, 24);
        slice.forEach((b: unknown, idx: number) => {
          if (!b || typeof b !== "object") return;
          const o = b as Record<string, unknown>;
          const title = String(o.title ?? "").trim().slice(0, 120);
          const hour = clamp(Number(o.hour) || 0, 0, 23);
          const smRaw = Number(o.startMinute);
          const startMinute = Number.isFinite(smRaw)
            ? clamp(Math.round(smRaw), 0, 59)
            : undefined;
          const dur = clamp(Number(o.durationMinutes) || 60, 15, MAX_BLOCK_DURATION);
          const cat = normalizeRoutineCat(o.category);
          if (!cat || !title) return;
          mapped.push({
            id: Date.now() + idx + Math.floor(Math.random() * 1000),
            title,
            hour,
            ...(startMinute !== undefined ? { startMinute } : {}),
            durationMinutes: dur,
            category: cat,
            date,
          } as TimelineEvent);
        });
        exec.setTimelineEvents((prev) => {
          const rest = prev.filter((e) => (e.date ?? exec.todayKey) !== date);
          return [...rest, ...mapped].sort(
            (a, b) => a.hour * 60 + (a.startMinute ?? 0) - (b.hour * 60 + (b.startMinute ?? 0)),
          ) as TimelineEvent[];
        });
        applied.push(`Set ${mapped.length} block(s) for ${date}.`);
        continue;
      }

      if (type === "add_timeline_block") {
        const title = String(act.title ?? "").trim().slice(0, 120);
        const hour = clamp(Number(act.hour) || 9, 0, 23);
        const smRaw = Number(act.startMinute);
        const startMinute = Number.isFinite(smRaw)
          ? clamp(Math.round(smRaw), 0, 59)
          : 0;
        const dur = clamp(Number(act.durationMinutes) || 60, 15, MAX_BLOCK_DURATION);
        const cat = normalizeRoutineCat(act.category);
        const dateRaw = act.date;
        const date = isIsoDay(dateRaw) ? dateRaw : exec.todayKey;
        if (!cat || !title) {
          errors.push("add_timeline_block: need title and category.");
          continue;
        }
        const ev = {
          id: Date.now() + Math.floor(Math.random() * 10000),
          title,
          hour,
          startMinute,
          durationMinutes: dur,
          category: cat,
          date,
        } as TimelineEvent;
        exec.setTimelineEvents((prev) =>
          [...prev, ev].sort(
            (a, b) => a.hour * 60 + (a.startMinute ?? 0) - (b.hour * 60 + (b.startMinute ?? 0)),
          ) as TimelineEvent[],
        );
        applied.push(`Added “${title}” at ${hour}:${String(startMinute).padStart(2, "0")}.`);
        continue;
      }

      if (type === "add_task") {
        const title = String(act.title ?? "").trim().slice(0, 200);
        const cat = normalizeRoutineCat(act.category) ?? "personal";
        const pri = normalizePriority(act.priority);
        if (!title) {
          errors.push("add_task: missing title.");
          continue;
        }
        exec.setTasks((prev) => [
          ...prev,
          {
            id: Date.now() + Math.floor(Math.random() * 10000),
            title,
            priority: pri,
            category: cat,
            done: false,
          } as Task,
        ]);
        applied.push(`Added task “${title}”.`);
        continue;
      }

      if (type === "complete_tasks") {
        const matchAll = Boolean(act.match_all_open);
        const titlesRaw = act.titles;
        if (matchAll) {
          exec.setTasks((prev) => prev.map((t) => ({ ...t, done: true })) as Task[]);
          applied.push("Marked all tasks complete.");
          continue;
        }
        if (!Array.isArray(titlesRaw) || titlesRaw.length === 0) {
          errors.push("complete_tasks: provide titles or match_all_open.");
          continue;
        }
        const needles = titlesRaw.map((t: unknown) => String(t).toLowerCase().trim()).filter(Boolean);
        let completed = 0;
        exec.setTasks((prev) =>
          prev.map((t) => {
            if (t.done) return t;
            const hit = needles.some(
              (q) => t.title.toLowerCase().includes(q) || q.includes(t.title.toLowerCase()),
            );
            if (!hit) return t;
            completed += 1;
            return { ...t, done: true };
          }) as Task[],
        );
        applied.push(`Completed ${completed} task(s).`);
        continue;
      }

      if (type === "add_transaction") {
        const amountAbs = Math.abs(Number(act.amount) || 0);
        const capped = Math.min(amountAbs, MAX_TX_AMOUNT);
        const txType = act.tx_type === "income" ? "income" : "expense";
        const category = pickTxCategory(act.category);
        const note = String(act.note ?? "").trim().slice(0, 240);
        const dateRaw = act.date;
        const date = isIsoDay(dateRaw) ? dateRaw : format(new Date(), "yyyy-MM-dd");
        if (capped <= 0) {
          errors.push("add_transaction: amount must be positive.");
          continue;
        }
        await exec.addTransaction({
          amount: capped,
          type: txType,
          category,
          note: note || (txType === "expense" ? "Coach Zero" : "Coach Zero income"),
          date,
        });
        applied.push(`Logged ${txType} ${category}: $${capped.toFixed(2)}.`);
        continue;
      }

      if (type === "add_plan_ahead") {
        const date = act.date;
        const title = String(act.title ?? "").trim().slice(0, 200);
        const hour = clamp(Number(act.hour) || 9, 0, 23);
        const cat = normalizeRoutineCat(act.category) ?? "personal";
        if (!isIsoDay(date) || !title) {
          errors.push("add_plan_ahead: need iso date and title.");
          continue;
        }
        await db.table("routinePlans").add({
          date,
          title,
          hour,
          category: cat,
          createdAt: new Date().toISOString(),
        });
        await exec.reloadPlanAhead();
        applied.push(`Plan ahead: “${title}” on ${date}.`);
        continue;
      }

      if (type === "add_subscription") {
        const name = String(act.name ?? "").trim().slice(0, 120);
        const amount = Math.min(Math.abs(Number(act.amount) || 0), MAX_TX_AMOUNT);
        const cycle = normalizeSubscriptionCycle(act.cycle);
        const nextBillingDate = act.nextBillingDate;
        if (!name || amount <= 0 || !cycle || !isIsoDay(nextBillingDate)) {
          errors.push("add_subscription: need name, amount, cycle, and nextBillingDate.");
          continue;
        }
        await exec.addSubscription({
          name,
          amount,
          cycle,
          nextBillingDate: new Date(nextBillingDate).toISOString(),
        });
        applied.push(`Added subscription “${name}” (${cycle}, $${amount.toFixed(2)}).`);
        continue;
      }

      if (type === "add_recurring_income") {
        const name = String(act.name ?? "").trim().slice(0, 120);
        const amount = Math.min(Math.abs(Number(act.amount) || 0), MAX_TX_AMOUNT);
        const cycle = normalizeRecurringIncomeCycle(act.cycle);
        const nextDate = act.nextDate;
        if (!name || amount <= 0 || !cycle || !isIsoDay(nextDate)) {
          errors.push("add_recurring_income: need name, amount, cycle, and nextDate.");
          continue;
        }
        await exec.addRecurringIncome({
          name,
          amount,
          cycle,
          nextDate: new Date(nextDate).toISOString(),
        });
        applied.push(`Added recurring income “${name}” (${cycle}, $${amount.toFixed(2)}).`);
        continue;
      }

      if (type === "add_planned_cashflow") {
        const title = String(act.title ?? "").trim().slice(0, 160);
        const amount = Math.min(Math.abs(Number(act.amount) || 0), MAX_TX_AMOUNT);
        const kind = normalizePlannedCashflowKind(act.kind);
        const date = act.date;
        const category = String(act.category ?? "").trim().slice(0, 80);
        if (!title || amount <= 0 || !kind || !isIsoDay(date)) {
          errors.push("add_planned_cashflow: need title, amount, kind, and date.");
          continue;
        }
        await exec.addPlannedCashflow({
          title,
          amount,
          kind,
          date: new Date(date).toISOString(),
          category: category || undefined,
        });
        applied.push(`Added ${kind === "savings_transfer" ? "savings transfer" : "planned expense"} “${title}”.`);
        continue;
      }

      if (type === "set_forecast_risk_threshold") {
        const amount = Math.max(0, Math.min(MAX_TX_AMOUNT, Number(act.amount) || 0));
        await exec.updateSettings({ forecastRiskThreshold: amount });
        applied.push(`Set risk threshold to $${amount.toFixed(2)}.`);
        continue;
      }

      if (type === "merge_transactions_to_summary") {
        const dateStart = act.date_start;
        const dateEnd = act.date_end;
        const txType = act.tx_type === "income" ? "income" : "expense";
        const matchCategory = String(act.match_category ?? "").trim().toLowerCase();
        const matchNote = String(act.match_note ?? "").trim().toLowerCase();
        const summaryNote = String(act.summary_note ?? "").trim().slice(0, 240);
        const summaryCategory = pickTxCategory(act.summary_category ?? act.match_category);
        const summaryDate = asIsoDayOrToday(act.summary_date, exec.todayKey);
        if (!isIsoDay(dateStart) || !isIsoDay(dateEnd)) {
          errors.push("merge_transactions_to_summary: need date_start and date_end.");
          continue;
        }
        if (!matchCategory && !matchNote) {
          errors.push("merge_transactions_to_summary: need match_category or match_note.");
          continue;
        }
        const matches = exec.getTransactions().filter((tx) => {
          if (!tx.id) return false;
          if (tx.type !== txType) return false;
          const day = format(parseISO(tx.date), "yyyy-MM-dd");
          if (day < dateStart || day > dateEnd) return false;
          if (matchCategory && !String(tx.category || "").toLowerCase().includes(matchCategory)) return false;
          if (matchNote && !String(tx.note || "").toLowerCase().includes(matchNote)) return false;
          return true;
        });
        if (matches.length < 2) {
          errors.push("merge_transactions_to_summary: need at least 2 matching transactions.");
          continue;
        }
        const totalAmount = matches.reduce((sum, tx) => sum + Math.abs(Number(tx.amount) || 0), 0);
        for (const tx of matches) {
          await exec.deleteTransaction(tx.id!);
        }
        await exec.addTransaction({
          amount: totalAmount,
          type: txType,
          category: summaryCategory,
          note: summaryNote || `Summary for ${matches.length} ${summaryCategory} transaction(s)`,
          date: summaryDate,
        });
        applied.push(`Merged ${matches.length} ${txType} transaction(s) into one summary for ${summaryCategory}.`);
        continue;
      }

      errors.push(`Unknown action type: ${type || "(empty)"}`);
    } catch (e) {
      errors.push(`${type}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  return { applied, errors };
}
