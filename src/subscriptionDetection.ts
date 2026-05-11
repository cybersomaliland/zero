import { addMonths, addWeeks, addYears, differenceInCalendarDays, format, parseISO, startOfDay } from "date-fns";
import type { Subscription, Transaction } from "./types";

export type DetectedSubscriptionCandidate = {
  signature: string;
  name: string;
  amount: number;
  cycle: Subscription["cycle"];
  matchCount: number;
  confidence: number;
  nextBillingDate: string;
  latestSeenDate: string;
  sampleNote: string;
  hint: string;
};

type CycleConfig = {
  cycle: Subscription["cycle"];
  targetDays: number;
  minDays: number;
  maxDays: number;
};

const CYCLE_CONFIGS: CycleConfig[] = [
  { cycle: "weekly", targetDays: 7, minDays: 5, maxDays: 9 },
  { cycle: "monthly", targetDays: 30, minDays: 25, maxDays: 35 },
  { cycle: "yearly", targetDays: 365, minDays: 330, maxDays: 390 },
];

function cleanToken(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(?:paid|payment|invoice|bill|subscription|membership|plan|charge|debit)\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleize(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function merchantKey(tx: Transaction) {
  const note = String(tx.note || "").trim();
  const cleaned = cleanToken(note);
  if (cleaned.length >= 3) return cleaned;
  const category = String(tx.category || "").trim().toLowerCase();
  return cleanToken(category);
}

function nextDateForCycle(dateIso: string, cycle: Subscription["cycle"]) {
  const date = parseISO(dateIso);
  if (cycle === "weekly") return addWeeks(date, 1);
  if (cycle === "monthly") return addMonths(date, 1);
  return addYears(date, 1);
}

function cycleForIntervals(intervals: number[]): CycleConfig | null {
  for (const config of CYCLE_CONFIGS) {
    if (intervals.every((days) => days >= config.minDays && days <= config.maxDays)) {
      return config;
    }
  }
  return null;
}

function confidenceFromPattern(matchCount: number, amountSpreadPct: number, avgGapDrift: number) {
  const occurrenceBoost = Math.min(22, Math.max(0, (matchCount - 2) * 8));
  const amountPenalty = Math.min(18, amountSpreadPct * 120);
  const gapPenalty = Math.min(14, avgGapDrift * 2.2);
  return Math.max(0, Math.min(100, Math.round(62 + occurrenceBoost - amountPenalty - gapPenalty)));
}

export function detectSubscriptionCandidates(
  transactions: Transaction[],
  subscriptions: Subscription[],
  dismissedSignatures: Set<string>,
): DetectedSubscriptionCandidate[] {
  const existingKeys = new Set(subscriptions.map((sub) => cleanToken(sub.name)));
  const grouped = new Map<string, Transaction[]>();

  for (const tx of transactions) {
    if (tx.type !== "expense") continue;
    const key = merchantKey(tx);
    if (key.length < 3) continue;
    const list = grouped.get(key) ?? [];
    list.push(tx);
    grouped.set(key, list);
  }

  const candidates: DetectedSubscriptionCandidate[] = [];

  for (const [key, rows] of grouped.entries()) {
    if (existingKeys.has(key)) continue;
    if (rows.length < 2) continue;

    const sorted = [...rows].sort((a, b) => +parseISO(a.date) - +parseISO(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = startOfDay(parseISO(sorted[i - 1].date));
      const next = startOfDay(parseISO(sorted[i].date));
      intervals.push(differenceInCalendarDays(next, prev));
    }
    if (intervals.length === 0) continue;

    const cycleMatch = cycleForIntervals(intervals);
    if (!cycleMatch) continue;

    const amounts = sorted.map((tx) => Math.abs(Number(tx.amount) || 0)).filter((amount) => amount > 0);
    if (amounts.length < 2) continue;
    const avgAmount = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
    const minAmount = Math.min(...amounts);
    const maxAmount = Math.max(...amounts);
    const amountSpreadPct = avgAmount > 0 ? (maxAmount - minAmount) / avgAmount : 1;
    const allowedSpread = cycleMatch.cycle === "yearly" ? 0.2 : 0.12;
    const allowedSpreadAbs = cycleMatch.cycle === "yearly" ? 12 : 4;
    if (amountSpreadPct > allowedSpread && maxAmount - minAmount > allowedSpreadAbs) continue;

    const avgGap = intervals.reduce((sum, days) => sum + days, 0) / intervals.length;
    const avgGapDrift = Math.abs(avgGap - cycleMatch.targetDays);
    const latest = sorted[sorted.length - 1];
    const nextBillingDate = format(nextDateForCycle(latest.date, cycleMatch.cycle), "yyyy-MM-dd");
    const roundedAmount = Number(avgAmount.toFixed(2));
    const signature = `${key}|${cycleMatch.cycle}|${roundedAmount.toFixed(2)}`;
    if (dismissedSignatures.has(signature)) continue;

    const sampleNote = String(latest.note || titleize(key)).trim() || titleize(key);
    const prettyName = titleize(cleanToken(sampleNote) || key);
    const confidence = confidenceFromPattern(sorted.length, amountSpreadPct, avgGapDrift);
    if (confidence < 58) continue;

    candidates.push({
      signature,
      name: prettyName || "Recurring charge",
      amount: roundedAmount,
      cycle: cycleMatch.cycle,
      matchCount: sorted.length,
      confidence,
      nextBillingDate,
      latestSeenDate: format(parseISO(latest.date), "yyyy-MM-dd"),
      sampleNote: latest.note || prettyName || "Recurring charge",
      hint: `Seen ${sorted.length} times about every ${cycleMatch.targetDays} day(s). Next likely hit ${format(parseISO(nextBillingDate), "MMM d")}.`,
    });
  }

  return candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.latestSeenDate.localeCompare(a.latestSeenDate);
  });
}
