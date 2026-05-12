import { addDays, differenceInCalendarDays, format, parseISO, startOfDay, subDays } from "date-fns";
import { detectSubscriptionCandidates } from "./subscriptionDetection";
import type { CoachMemory, Subscription, Transaction } from "./types";

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const WEEKEND_MEMORY_WINDOW_DAYS = 56;
const PAYDAY_MEMORY_WINDOW_DAYS = 90;

function money(value: number) {
  return MONEY.format(Number.isFinite(value) ? value : 0);
}

function round(value: number) {
  return Number(value.toFixed(2));
}

function isWeekend(date: Date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function clampConfidence(value: number) {
  return Math.max(55, Math.min(96, Math.round(value)));
}

function toDayStart(input: string) {
  return startOfDay(parseISO(input));
}

function buildWeekendOverspendMemory(transactions: Transaction[], referenceDate: Date): Omit<CoachMemory, "id" | "createdAt"> | null {
  const end = startOfDay(referenceDate);
  const start = subDays(end, WEEKEND_MEMORY_WINDOW_DAYS - 1);
  const recentExpenses = transactions.filter((tx) => {
    if (tx.type !== "expense") return false;
    const txDate = toDayStart(tx.date);
    return txDate >= start && txDate <= end;
  });
  if (recentExpenses.length < 8) return null;

  let weekendTotal = 0;
  let weekdayTotal = 0;
  let latestObserved = "";

  for (const tx of recentExpenses) {
    const txDate = toDayStart(tx.date);
    latestObserved = tx.date > latestObserved ? tx.date : latestObserved;
    if (isWeekend(txDate)) {
      weekendTotal += Math.abs(Number(tx.amount) || 0);
    } else {
      weekdayTotal += Math.abs(Number(tx.amount) || 0);
    }
  }

  const totalDays = differenceInCalendarDays(end, start) + 1;
  let weekendDays = 0;
  for (let index = 0; index < totalDays; index += 1) {
    if (isWeekend(addDays(start, index))) weekendDays += 1;
  }
  const weekdayDays = Math.max(1, totalDays - weekendDays);
  if (weekendDays <= 0) return null;

  const weekendAvg = weekendTotal / weekendDays;
  const weekdayAvg = weekdayTotal / weekdayDays;
  const ratio = weekendAvg / Math.max(0.01, weekdayAvg);
  if (weekendAvg < 5 || ratio < 1.18) return null;

  const deltaPct = Math.round((ratio - 1) * 100);
  return {
    kind: "weekend_overspend",
    title: "You usually spend more on weekends",
    summary: `Weekend spending is averaging ${money(weekendAvg)} per day versus ${money(weekdayAvg)} on weekdays.`,
    evidence: [
      `Across the last ${Math.round(WEEKEND_MEMORY_WINDOW_DAYS / 7)} weeks, weekend spending ran about ${deltaPct}% higher than weekdays.`,
      "This is a flexible-spend pressure point worth tightening before the weekend starts.",
    ],
    confidence: clampConfidence(62 + deltaPct * 0.55 + recentExpenses.length * 0.35),
    updatedAt: latestObserved || format(end, "yyyy-MM-dd"),
  };
}

function buildUntrackedSubscriptionMemory(
  transactions: Transaction[],
  subscriptions: Subscription[],
  dismissedSignatures: string[],
): Omit<CoachMemory, "id" | "createdAt"> | null {
  const candidates = detectSubscriptionCandidates(transactions, subscriptions, new Set(dismissedSignatures));
  const candidate = candidates[0];
  if (!candidate || candidate.confidence < 70) return null;

  return {
    kind: "subscription_blindspot",
    title: "One recurring charge still slips through",
    summary: `${candidate.name} looks like an unsaved ${candidate.cycle} bill around ${money(candidate.amount)}.`,
    evidence: [
      `It showed up ${candidate.matchCount} times in your transactions without being saved as a subscription.`,
      `Next likely hit: ${format(parseISO(candidate.nextBillingDate), "MMM d")}.`,
    ],
    confidence: clampConfidence(candidate.confidence),
    updatedAt: candidate.latestSeenDate,
  };
}

function buildPostPaydayMemory(transactions: Transaction[], referenceDate: Date): Omit<CoachMemory, "id" | "createdAt"> | null {
  const end = startOfDay(referenceDate);
  const start = subDays(end, PAYDAY_MEMORY_WINDOW_DAYS - 1);
  const recentIncome = transactions
    .filter((tx) => {
      if (tx.type !== "income") return false;
      const txDate = toDayStart(tx.date);
      return txDate >= start && txDate <= end;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (recentIncome.length < 2) return null;

  const recentExpenses = transactions.filter((tx) => {
    if (tx.type !== "expense") return false;
    const txDate = toDayStart(tx.date);
    return txDate >= start && txDate <= end;
  });
  if (recentExpenses.length < 6) return null;

  const overallAvgDailyExpense = recentExpenses.reduce((sum, tx) => sum + Math.abs(Number(tx.amount) || 0), 0)
    / Math.max(1, differenceInCalendarDays(end, start) + 1);
  if (overallAvgDailyExpense <= 0) return null;

  const postPaydayDailySpend = recentIncome.map((income) => {
    const payday = toDayStart(income.date);
    const windowEnd = addDays(payday, 2);
    const total = recentExpenses.reduce((sum, tx) => {
      const txDate = toDayStart(tx.date);
      return txDate >= payday && txDate <= windowEnd ? sum + Math.abs(Number(tx.amount) || 0) : sum;
    }, 0);
    return total / 3;
  });
  if (postPaydayDailySpend.length < 2) return null;

  const avgPostPaydaySpend = postPaydayDailySpend.reduce((sum, value) => sum + value, 0) / postPaydayDailySpend.length;
  const ratio = avgPostPaydaySpend / overallAvgDailyExpense;
  if (ratio > 0.82) return null;

  const improvementPct = Math.round((1 - ratio) * 100);
  return {
    kind: "post_payday_savings",
    title: "Your best savings streak starts after payday",
    summary: `The first 3 days after income average ${money(avgPostPaydaySpend)}/day of spending versus ${money(overallAvgDailyExpense)}/day overall.`,
    evidence: [
      `Across ${postPaydayDailySpend.length} recent payday window(s), spending dropped about ${improvementPct}% right after income landed.`,
      "That payday window is your easiest time to move money into savings before lifestyle spend picks up.",
    ],
    confidence: clampConfidence(60 + improvementPct * 0.7 + postPaydayDailySpend.length * 4),
    updatedAt: recentIncome[recentIncome.length - 1]?.date ?? format(end, "yyyy-MM-dd"),
  };
}

export function buildCoachMemories(params: {
  transactions: Transaction[];
  subscriptions: Subscription[];
  dismissedSubscriptionSuggestions?: string[];
  referenceDate?: Date;
}): Array<Omit<CoachMemory, "id" | "createdAt">> {
  const referenceDate = params.referenceDate ?? new Date();
  const memories = [
    buildWeekendOverspendMemory(params.transactions, referenceDate),
    buildUntrackedSubscriptionMemory(
      params.transactions,
      params.subscriptions,
      params.dismissedSubscriptionSuggestions ?? [],
    ),
    buildPostPaydayMemory(params.transactions, referenceDate),
  ].filter((memory): memory is Omit<CoachMemory, "id" | "createdAt"> => memory != null);

  return memories
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .map((memory) => ({
      ...memory,
      confidence: clampConfidence(round(memory.confidence)),
    }))
    .slice(0, 4);
}
