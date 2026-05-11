import { addDays, addMonths, addWeeks, addYears, endOfMonth, format, getDay, parseISO, startOfDay } from "date-fns";
import type {
  PlannedCashflowItem,
  RecurringIncome,
  RecurringIncomeCycle,
  Settings,
  Subscription,
  Transaction,
} from "./types";

export type CashflowForecastEventKind =
  | "recurring_income"
  | "subscription"
  | "planned_expense"
  | "savings_transfer"
  | "baseline_spend";

export type CashflowForecastEvent = {
  date: string;
  label: string;
  amount: number;
  kind: CashflowForecastEventKind;
};

export type CashflowForecastPoint = {
  date: string;
  label: string;
  balance: number;
  bestBalance: number;
  worstBalance: number;
  delta: number;
  belowThreshold: boolean;
  events: CashflowForecastEvent[];
};

export type CashflowSpendingProfile = {
  weekdayEssential: number;
  weekdayFlexible: number;
  weekendEssential: number;
  weekendFlexible: number;
};

export type CashflowCategoryTrend = {
  category: string;
  recent30Total: number;
  previous30Total: number;
  changePct: number;
  direction: "rising" | "steady" | "falling";
  spendClass: "essential" | "flexible";
};

export type CashflowCheckpoint = {
  label: string;
  date: string;
  bestBalance: number;
  likelyBalance: number;
  worstBalance: number;
};

export type CashflowRequiredCorrection = {
  amountPerDay: number;
  days: number;
  targetDate: string;
  targetLabel: string;
};

export type CashflowIrregularExpense = {
  date: string;
  label: string;
  amount: number;
  category: string;
};

export type CashflowSalaryContext = {
  monthlySalary: number;
  recurringSubscriptionsMonthly: number;
  salaryAfterSubscriptions: number;
  monthlyEssentialSpend: number;
  monthlyFlexibleSpend: number;
  monthlyObservedSpend: number;
  monthlyNetAfterTransactions: number;
};

export type CashflowForecastResult = {
  points: CashflowForecastPoint[];
  threshold: number;
  baselineDailySpend: number;
  spendingProfile: CashflowSpendingProfile;
  bestCaseLowestBalance: number;
  worstCaseLowestBalance: number;
  salaryContext: CashflowSalaryContext;
  lowestPoint: CashflowForecastPoint | null;
  nextRiskDay: CashflowForecastPoint | null;
  riskDays: CashflowForecastPoint[];
  nextPayday: CashflowForecastEvent | null;
  upcomingEvents: CashflowForecastEvent[];
  categoryTrends: CashflowCategoryTrend[];
  checkpoints: {
    nextPayday: CashflowCheckpoint | null;
    monthEnd: CashflowCheckpoint | null;
  };
  requiredCorrection: CashflowRequiredCorrection | null;
  irregularExpenses: CashflowIrregularExpense[];
};

type SpendClass = "essential" | "flexible";
type DayType = "weekday" | "weekend";
type SegmentKey = `${DayType}_${SpendClass}`;
type SegmentAverages = Record<SegmentKey, number>;
type WindowExpenseSnapshot = {
  averages: SegmentAverages;
  categoryTotals: Record<string, number>;
};

const ESSENTIAL_CATEGORIES = new Set([
  "groceries",
  "transport",
  "housing",
  "health",
  "education",
  "subscriptions",
  "bills",
  "fees & charges",
  "savings",
]);

const EMPTY_SEGMENT_AVERAGES: SegmentAverages = {
  weekday_essential: 0,
  weekday_flexible: 0,
  weekend_essential: 0,
  weekend_flexible: 0,
};
const AVG_DAYS_PER_MONTH = 30.4375;

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function isValidDate(input: string) {
  const parsed = parseISO(input);
  return Number.isFinite(+parsed);
}

function isoDay(input: string) {
  return format(parseISO(input), "yyyy-MM-dd");
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function addIncomeCycle(date: Date, cycle: RecurringIncomeCycle) {
  if (cycle === "weekly") return addWeeks(date, 1);
  if (cycle === "biweekly") return addWeeks(date, 2);
  return addMonths(date, 1);
}

function addSubscriptionCycle(date: Date, cycle: Subscription["cycle"]) {
  if (cycle === "weekly") return addWeeks(date, 1);
  if (cycle === "monthly") return addMonths(date, 1);
  return addYears(date, 1);
}

function expandRecurringIncome(
  rows: RecurringIncome[],
  start: Date,
  end: Date,
): CashflowForecastEvent[] {
  const events: CashflowForecastEvent[] = [];
  for (const row of rows) {
    if (!isValidDate(row.nextDate)) continue;
    let cursor = startOfDay(parseISO(row.nextDate));
    while (cursor < start) {
      cursor = startOfDay(addIncomeCycle(cursor, row.cycle));
    }
    while (cursor <= end) {
      events.push({
        date: format(cursor, "yyyy-MM-dd"),
        label: row.name || "Payday",
        amount: roundMoney(Math.abs(Number(row.amount) || 0)),
        kind: "recurring_income",
      });
      cursor = startOfDay(addIncomeCycle(cursor, row.cycle));
    }
  }
  return events;
}

function expandSubscriptions(
  rows: Subscription[],
  start: Date,
  end: Date,
): CashflowForecastEvent[] {
  const events: CashflowForecastEvent[] = [];
  for (const row of rows) {
    if (!isValidDate(row.nextBillingDate)) continue;
    let cursor = startOfDay(parseISO(row.nextBillingDate));
    while (cursor < start) {
      cursor = startOfDay(addSubscriptionCycle(cursor, row.cycle));
    }
    while (cursor <= end) {
      events.push({
        date: format(cursor, "yyyy-MM-dd"),
        label: row.name || "Bill",
        amount: roundMoney(-Math.abs(Number(row.amount) || 0)),
        kind: "subscription",
      });
      cursor = startOfDay(addSubscriptionCycle(cursor, row.cycle));
    }
  }
  return events;
}

function expandPlannedCashflows(
  rows: PlannedCashflowItem[],
  start: Date,
  end: Date,
): CashflowForecastEvent[] {
  return rows
    .filter((row) => isValidDate(row.date))
    .map((row) => {
      const date = startOfDay(parseISO(row.date));
      return { row, date };
    })
    .filter(({ date }) => date >= start && date <= end)
    .map(({ row, date }) => ({
      date: format(date, "yyyy-MM-dd"),
      label: row.title || (row.kind === "savings_transfer" ? "Savings transfer" : "Planned expense"),
      amount: roundMoney(-Math.abs(Number(row.amount) || 0)),
      kind: row.kind,
    }));
}

function shouldExcludeModeledSubscription(tx: Transaction, subscriptions: Subscription[]) {
  return subscriptions.length > 0 && String(tx.category || "").toLowerCase() === "subscriptions";
}

function classifySpend(tx: Transaction): SpendClass {
  const key = String(tx.category || "").toLowerCase();
  return ESSENTIAL_CATEGORIES.has(key) ? "essential" : "flexible";
}

function getDayType(date: Date): DayType {
  const day = getDay(date);
  return day === 0 || day === 6 ? "weekend" : "weekday";
}

function segmentKey(dayType: DayType, spendClass: SpendClass): SegmentKey {
  return `${dayType}_${spendClass}`;
}

function countWindowDays(start: Date, end: Date): Record<DayType, number> {
  const counts = { weekday: 0, weekend: 0 };
  for (let cursor = startOfDay(start); cursor <= end; cursor = startOfDay(addDays(cursor, 1))) {
    counts[getDayType(cursor)] += 1;
  }
  return counts;
}

function buildWindowExpenseSnapshot(
  transactions: Transaction[],
  subscriptions: Subscription[],
  start: Date,
  end: Date,
): WindowExpenseSnapshot {
  const totals: Record<SegmentKey, number> = { ...EMPTY_SEGMENT_AVERAGES };
  const categoryTotals: Record<string, number> = {};
  const dayCounts = countWindowDays(start, end);

  for (const tx of transactions) {
    if (tx.type !== "expense") continue;
    if (!isValidDate(tx.date)) continue;
    if (shouldExcludeModeledSubscription(tx, subscriptions)) continue;
    const day = startOfDay(parseISO(tx.date));
    if (day < start || day > end) continue;
    const amount = Math.abs(Number(tx.amount) || 0);
    const className = classifySpend(tx);
    const key = segmentKey(getDayType(day), className);
    totals[key] += amount;
    const category = String(tx.category || "General");
    categoryTotals[category] = (categoryTotals[category] || 0) + amount;
  }

  return {
    averages: {
      weekday_essential: roundMoney(totals.weekday_essential / Math.max(1, dayCounts.weekday)),
      weekday_flexible: roundMoney(totals.weekday_flexible / Math.max(1, dayCounts.weekday)),
      weekend_essential: roundMoney(totals.weekend_essential / Math.max(1, dayCounts.weekend)),
      weekend_flexible: roundMoney(totals.weekend_flexible / Math.max(1, dayCounts.weekend)),
    },
    categoryTotals,
  };
}

function averageDailySpend(averages: SegmentAverages) {
  return roundMoney(
    (averages.weekday_essential + averages.weekday_flexible) * (5 / 7)
    + (averages.weekend_essential + averages.weekend_flexible) * (2 / 7),
  );
}

function combineSegmentAverages(
  likelyWindow: WindowExpenseSnapshot,
  comparisonWindow: WindowExpenseSnapshot,
) {
  const keys = Object.keys(EMPTY_SEGMENT_AVERAGES) as SegmentKey[];
  const next: SegmentAverages = { ...EMPTY_SEGMENT_AVERAGES };
  for (const key of keys) {
    const recent = likelyWindow.averages[key];
    const previous = comparisonWindow.averages[key];
    next[key] = recent > 0 ? recent : previous;
  }
  return next;
}

function buildCategoryTrends(
  transactions: Transaction[],
  subscriptions: Subscription[],
  referenceDate = new Date(),
) {
  const windowEnd = startOfDay(referenceDate);
  const recentStart = startOfDay(addDays(referenceDate, -29));
  const previousEnd = startOfDay(addDays(recentStart, -1));
  const previousStart = startOfDay(addDays(previousEnd, -29));
  const recent = buildWindowExpenseSnapshot(transactions, subscriptions, recentStart, windowEnd);
  const previous = buildWindowExpenseSnapshot(transactions, subscriptions, previousStart, previousEnd);
  const keys = new Set([...Object.keys(recent.categoryTotals), ...Object.keys(previous.categoryTotals)]);

  return [...keys]
    .map((category) => {
      const recent30Total = roundMoney(recent.categoryTotals[category] || 0);
      const previous30Total = roundMoney(previous.categoryTotals[category] || 0);
      const changePct = previous30Total > 0
        ? roundMoney(((recent30Total - previous30Total) / previous30Total) * 100)
        : recent30Total > 0 ? 100 : 0;
      const direction = changePct > 15 ? "rising" : changePct < -15 ? "falling" : "steady";
      return {
        category,
        recent30Total,
        previous30Total,
        changePct,
        direction,
        spendClass: ESSENTIAL_CATEGORIES.has(category.toLowerCase()) ? "essential" : "flexible",
      } satisfies CashflowCategoryTrend;
    })
    .filter((trend) => trend.recent30Total > 0 || trend.previous30Total > 0)
    .sort((a, b) => b.recent30Total - a.recent30Total)
    .slice(0, 6);
}

function weightedTrendMultiplier(trends: CashflowCategoryTrend[], spendClass: SpendClass) {
  const scoped = trends.filter((trend) => trend.spendClass === spendClass && trend.recent30Total > 0);
  if (scoped.length === 0) return 1;
  const total = scoped.reduce((sum, trend) => sum + trend.recent30Total, 0);
  if (total <= 0) return 1;
  const weightedPct = scoped.reduce((sum, trend) => sum + trend.changePct * (trend.recent30Total / total), 0);
  const strength = spendClass === "flexible" ? 0.12 : 0.05;
  return clamp(1 + (weightedPct / 100) * strength, spendClass === "flexible" ? 0.85 : 0.92, spendClass === "flexible" ? 1.2 : 1.1);
}

function detectIrregularExpenses(
  transactions: Transaction[],
  subscriptions: Subscription[],
  referenceDate = new Date(),
): CashflowIrregularExpense[] {
  const windowStart = startOfDay(addDays(referenceDate, -365));
  const expenseRows = transactions
    .filter((tx) => tx.type === "expense" && isValidDate(tx.date) && !shouldExcludeModeledSubscription(tx, subscriptions))
    .filter((tx) => {
      const day = startOfDay(parseISO(tx.date));
      return day >= windowStart && day <= referenceDate;
    });
  if (expenseRows.length === 0) return [];
  const amounts = expenseRows.map((tx) => Math.abs(Number(tx.amount) || 0)).sort((a, b) => a - b);
  const median = amounts[Math.floor(amounts.length / 2)] || 0;
  const average = amounts.reduce((sum, amount) => sum + amount, 0) / Math.max(1, amounts.length);
  const floor = Math.max(60, median * 2.2, average * 1.7);
  return expenseRows
    .filter((tx) => Math.abs(Number(tx.amount) || 0) >= floor)
    .sort((a, b) => +parseISO(b.date) - +parseISO(a.date))
    .slice(0, 5)
    .map((tx) => ({
      date: format(parseISO(tx.date), "yyyy-MM-dd"),
      label: tx.note?.trim() || tx.category || "Large expense",
      amount: roundMoney(Math.abs(Number(tx.amount) || 0)),
      category: tx.category || "General",
    }));
}

function irregularReservePerDay(items: CashflowIrregularExpense[]) {
  if (items.length === 0) return 0;
  const avgSpike = items.reduce((sum, item) => sum + item.amount, 0) / items.length;
  return roundMoney(avgSpike / 90);
}

function inferSpendingProfile(
  transactions: Transaction[],
  subscriptions: Subscription[],
  referenceDate: Date,
  categoryTrends: CashflowCategoryTrend[],
) {
  const recentStart = startOfDay(addDays(referenceDate, -29));
  const recent = buildWindowExpenseSnapshot(transactions, subscriptions, recentStart, startOfDay(referenceDate));
  const previousStart = startOfDay(addDays(referenceDate, -59));
  const previousEnd = startOfDay(addDays(referenceDate, -30));
  const previous = buildWindowExpenseSnapshot(transactions, subscriptions, previousStart, previousEnd);
  const combined = combineSegmentAverages(recent, previous);
  const essentialTrend = weightedTrendMultiplier(categoryTrends, "essential");
  const flexibleTrend = weightedTrendMultiplier(categoryTrends, "flexible");
  return {
    weekdayEssential: roundMoney(combined.weekday_essential * essentialTrend),
    weekdayFlexible: roundMoney(combined.weekday_flexible * flexibleTrend),
    weekendEssential: roundMoney(combined.weekend_essential * essentialTrend),
    weekendFlexible: roundMoney(combined.weekend_flexible * flexibleTrend),
  } satisfies CashflowSpendingProfile;
}

function inferFallbackRecurringIncome(
  settings: Settings,
  transactions: Transaction[],
  referenceDate: Date,
): RecurringIncome[] {
  const amount = Math.abs(Number(settings.monthlySalary) || 0);
  if (amount <= 0) return [];

  const latestIncome = [...transactions]
    .filter((tx) => tx.type === "income" && isValidDate(tx.date))
    .sort((a, b) => +parseISO(b.date) - +parseISO(a.date))[0];

  let nextDate: Date;
  if (latestIncome) {
    nextDate = startOfDay(parseISO(latestIncome.date));
    while (nextDate <= referenceDate) {
      nextDate = startOfDay(addMonths(nextDate, 1));
    }
  } else {
    nextDate = startOfDay(new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 1));
  }

  return [{
    name: "Planned salary",
    amount,
    cycle: "monthly",
    nextDate: nextDate.toISOString(),
    createdAt: new Date().toISOString(),
  }];
}

function monthlySubscriptionRunRate(subscriptions: Subscription[]) {
  return roundMoney(subscriptions.reduce((sum, sub) => {
    if (sub.cycle === "weekly") return sum + sub.amount * (52 / 12);
    if (sub.cycle === "yearly") return sum + sub.amount / 12;
    return sum + sub.amount;
  }, 0));
}

function monthlySpendFromDaily(daily: number) {
  return roundMoney(daily * AVG_DAYS_PER_MONTH);
}

export function buildCashflowForecast(params: {
  transactions: Transaction[];
  subscriptions: Subscription[];
  recurringIncome: RecurringIncome[];
  plannedCashflows: PlannedCashflowItem[];
  settings: Settings;
  horizonDays?: number;
  referenceDate?: Date;
}) : CashflowForecastResult {
  const referenceDate = params.referenceDate ?? new Date();
  const start = startOfDay(referenceDate);
  const horizonDays = Math.max(7, Math.min(180, Math.round(params.horizonDays ?? 30)));
  const end = startOfDay(addDays(start, horizonDays));
  const threshold = roundMoney(Math.max(0, Number(params.settings.forecastRiskThreshold ?? params.settings.reservedSavings ?? 0)));
  const categoryTrends = buildCategoryTrends(params.transactions, params.subscriptions, referenceDate);
  const irregularExpenses = detectIrregularExpenses(params.transactions, params.subscriptions, referenceDate);
  const irregularReserve = irregularReservePerDay(irregularExpenses);
  const spendingProfile = inferSpendingProfile(params.transactions, params.subscriptions, referenceDate, categoryTrends);
  const likelyEssentialDaily = roundMoney((spendingProfile.weekdayEssential * 5 + spendingProfile.weekendEssential * 2) / 7);
  const likelyFlexibleDaily = roundMoney((spendingProfile.weekdayFlexible * 5 + spendingProfile.weekendFlexible * 2) / 7);
  const baselineDailySpend = averageDailySpend({
    weekday_essential: spendingProfile.weekdayEssential,
    weekday_flexible: spendingProfile.weekdayFlexible,
    weekend_essential: spendingProfile.weekendEssential,
    weekend_flexible: spendingProfile.weekendFlexible,
  });
  const salaryContext: CashflowSalaryContext = {
    monthlySalary: roundMoney(Math.abs(Number(params.settings.monthlySalary) || 0)),
    recurringSubscriptionsMonthly: monthlySubscriptionRunRate(params.subscriptions),
    salaryAfterSubscriptions: 0,
    monthlyEssentialSpend: monthlySpendFromDaily(likelyEssentialDaily),
    monthlyFlexibleSpend: monthlySpendFromDaily(likelyFlexibleDaily),
    monthlyObservedSpend: 0,
    monthlyNetAfterTransactions: 0,
  };
  salaryContext.salaryAfterSubscriptions = roundMoney(salaryContext.monthlySalary - salaryContext.recurringSubscriptionsMonthly);
  salaryContext.monthlyObservedSpend = roundMoney(salaryContext.monthlyEssentialSpend + salaryContext.monthlyFlexibleSpend);
  salaryContext.monthlyNetAfterTransactions = roundMoney(
    salaryContext.salaryAfterSubscriptions - salaryContext.monthlyObservedSpend,
  );
  const recurringIncomeRows = params.recurringIncome.length > 0
    ? params.recurringIncome
    : inferFallbackRecurringIncome(params.settings, params.transactions, referenceDate);
  const eventMap = new Map<string, CashflowForecastEvent[]>();
  const addEvent = (event: CashflowForecastEvent) => {
    const list = eventMap.get(event.date) ?? [];
    list.push(event);
    eventMap.set(event.date, list);
  };

  expandRecurringIncome(recurringIncomeRows, start, end).forEach(addEvent);
  expandSubscriptions(params.subscriptions, start, end).forEach(addEvent);
  expandPlannedCashflows(params.plannedCashflows, start, end).forEach(addEvent);

  let balance = roundMoney(Number(params.settings.currentBalance) || 0);
  let bestBalance = balance;
  let worstBalance = balance;
  const points: CashflowForecastPoint[] = [];

  for (let i = 0; i <= horizonDays; i += 1) {
    const day = startOfDay(addDays(start, i));
    const key = format(day, "yyyy-MM-dd");
    const dayType = getDayType(day);
    const events = [...(eventMap.get(key) ?? [])];
    const likelySpend = roundMoney(
      dayType === "weekday"
        ? spendingProfile.weekdayEssential + spendingProfile.weekdayFlexible
        : spendingProfile.weekendEssential + spendingProfile.weekendFlexible,
    );
    const bestSpend = roundMoney(
      dayType === "weekday"
        ? spendingProfile.weekdayEssential * 0.96 + spendingProfile.weekdayFlexible * 0.74
        : spendingProfile.weekendEssential * 0.96 + spendingProfile.weekendFlexible * 0.74,
    );
    const worstSpend = roundMoney(
      (dayType === "weekday"
        ? spendingProfile.weekdayEssential * 1.04 + spendingProfile.weekdayFlexible * 1.32
        : spendingProfile.weekendEssential * 1.04 + spendingProfile.weekendFlexible * 1.32)
      + irregularReserve,
    );

    if (i > 0 && likelySpend > 0) {
      events.unshift({
        date: key,
        label: "Daily spending pace",
        amount: -likelySpend,
        kind: "baseline_spend",
      });
    }

    const scheduledDelta = roundMoney(events.reduce((sum, event) => (
      event.kind === "baseline_spend" ? sum : sum + event.amount
    ), 0));
    const delta = roundMoney(scheduledDelta - (i > 0 ? likelySpend : 0));
    balance = roundMoney(balance + delta);
    bestBalance = roundMoney(bestBalance + scheduledDelta - (i > 0 ? bestSpend : 0));
    worstBalance = roundMoney(worstBalance + scheduledDelta - (i > 0 ? worstSpend : 0));
    points.push({
      date: key,
      label: format(day, "MMM d"),
      balance,
      bestBalance,
      worstBalance,
      delta,
      belowThreshold: balance < threshold,
      events,
    });
  }

  const riskDays = points.filter((point) => point.belowThreshold);
  const lowestPoint = points.reduce<CashflowForecastPoint | null>((lowest, point) => {
    if (!lowest || point.balance < lowest.balance) return point;
    return lowest;
  }, null);
  const upcomingEvents = points
    .flatMap((point) => point.events)
    .filter((event) => event.kind !== "baseline_spend")
    .sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  const nextPayday = upcomingEvents.find((event) => event.kind === "recurring_income") ?? null;
  const nextPaydayPoint = nextPayday
    ? points.find((point) => point.date === nextPayday.date) ?? null
    : null;
  const monthEndKey = format(endOfMonth(referenceDate), "yyyy-MM-dd");
  const monthEndPoint = points.find((point) => point.date === monthEndKey) ?? points[points.length - 1] ?? null;
  const lowestLikelyBalance = lowestPoint?.balance ?? balance;
  const correctionTargetPoint = nextPaydayPoint && nextPaydayPoint.date <= (lowestPoint?.date ?? monthEndKey)
    ? nextPaydayPoint
    : lowestPoint;
  const likelyFlexibleAverage = roundMoney((spendingProfile.weekdayFlexible * 5 + spendingProfile.weekendFlexible * 2) / 7);
  const shortage = Math.max(0, threshold - lowestLikelyBalance);
  const correctionDays = correctionTargetPoint
    ? Math.max(1, Math.round((parseISO(correctionTargetPoint.date).getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))
    : 0;
  const monthlyFlexibleGapPerDay = salaryContext.monthlyNetAfterTransactions < 0
    ? Math.abs(salaryContext.monthlyNetAfterTransactions) / AVG_DAYS_PER_MONTH
    : 0;
  const targetBufferGapPerDay = shortage > 0 && correctionTargetPoint
    ? shortage / Math.max(1, correctionDays)
    : 0;
  const correctionAmountPerDay = roundMoney(Math.max(monthlyFlexibleGapPerDay, targetBufferGapPerDay));
  const requiredCorrection = shortage > 0 && correctionTargetPoint && likelyFlexibleAverage > 0
    ? {
      amountPerDay: correctionAmountPerDay,
      days: Math.max(1, correctionDays),
      targetDate: correctionTargetPoint.date,
      targetLabel: nextPaydayPoint && correctionTargetPoint.date === nextPaydayPoint.date ? "next payday" : "low point",
    } satisfies CashflowRequiredCorrection
    : salaryContext.monthlyNetAfterTransactions < 0 && likelyFlexibleAverage > 0
      ? {
        amountPerDay: roundMoney(monthlyFlexibleGapPerDay),
        days: Math.max(1, Math.round(AVG_DAYS_PER_MONTH)),
        targetDate: monthEndPoint?.date ?? monthEndKey,
        targetLabel: "month-end",
      } satisfies CashflowRequiredCorrection
    : null;

  return {
    points,
    threshold,
    baselineDailySpend,
    spendingProfile,
    bestCaseLowestBalance: Math.min(...points.map((point) => point.bestBalance)),
    worstCaseLowestBalance: Math.min(...points.map((point) => point.worstBalance)),
    salaryContext,
    lowestPoint,
    nextRiskDay: riskDays[0] ?? null,
    riskDays,
    nextPayday,
    upcomingEvents,
    categoryTrends,
    checkpoints: {
      nextPayday: nextPaydayPoint
        ? {
          label: "Next payday",
          date: nextPaydayPoint.date,
          bestBalance: nextPaydayPoint.bestBalance,
          likelyBalance: nextPaydayPoint.balance,
          worstBalance: nextPaydayPoint.worstBalance,
        }
        : null,
      monthEnd: monthEndPoint
        ? {
          label: "Month-end",
          date: monthEndPoint.date,
          bestBalance: monthEndPoint.bestBalance,
          likelyBalance: monthEndPoint.balance,
          worstBalance: monthEndPoint.worstBalance,
        }
        : null,
    },
    requiredCorrection,
    irregularExpenses,
  };
}

export function summarizeCashflowDay(point: CashflowForecastPoint) {
  const labels = point.events.map((event) => {
    const sign = event.amount >= 0 ? "+" : "-";
    return `${event.label} (${sign}$${Math.abs(event.amount).toFixed(2)})`;
  });
  return labels.join(", ");
}

export function sortCashflowItemsByDate<T extends { date: string }>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const dayA = isValidDate(a.date) ? isoDay(a.date) : a.date;
    const dayB = isValidDate(b.date) ? isoDay(b.date) : b.date;
    return dayA.localeCompare(dayB);
  });
}
