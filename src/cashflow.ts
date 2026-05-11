import { addDays, addMonths, addWeeks, addYears, format, parseISO, startOfDay } from "date-fns";
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
  delta: number;
  belowThreshold: boolean;
  events: CashflowForecastEvent[];
};

export type CashflowForecastResult = {
  points: CashflowForecastPoint[];
  threshold: number;
  baselineDailySpend: number;
  lowestPoint: CashflowForecastPoint | null;
  nextRiskDay: CashflowForecastPoint | null;
  riskDays: CashflowForecastPoint[];
  nextPayday: CashflowForecastEvent | null;
  upcomingEvents: CashflowForecastEvent[];
};

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

export function estimateBaselineDailySpend(
  transactions: Transaction[],
  referenceDate = new Date(),
) {
  const windowStart = startOfDay(addDays(referenceDate, -29));
  const windowEnd = startOfDay(referenceDate);
  const total = transactions.reduce((sum, tx) => {
    if (tx.type !== "expense") return sum;
    if (!isValidDate(tx.date)) return sum;
    const day = startOfDay(parseISO(tx.date));
    if (day < windowStart || day > windowEnd) return sum;
    if (String(tx.category || "").toLowerCase() === "subscriptions") return sum;
    return sum + Math.abs(Number(tx.amount) || 0);
  }, 0);
  const spanDays = Math.max(1, Math.round((windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  return roundMoney(total / spanDays);
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
  const baselineDailySpend = estimateBaselineDailySpend(params.transactions, referenceDate);
  const eventMap = new Map<string, CashflowForecastEvent[]>();
  const addEvent = (event: CashflowForecastEvent) => {
    const list = eventMap.get(event.date) ?? [];
    list.push(event);
    eventMap.set(event.date, list);
  };

  expandRecurringIncome(params.recurringIncome, start, end).forEach(addEvent);
  expandSubscriptions(params.subscriptions, start, end).forEach(addEvent);
  expandPlannedCashflows(params.plannedCashflows, start, end).forEach(addEvent);

  let balance = roundMoney(Number(params.settings.currentBalance) || 0);
  const points: CashflowForecastPoint[] = [];

  for (let i = 0; i <= horizonDays; i += 1) {
    const day = startOfDay(addDays(start, i));
    const key = format(day, "yyyy-MM-dd");
    const events = [...(eventMap.get(key) ?? [])];

    if (i > 0 && baselineDailySpend > 0) {
      events.unshift({
        date: key,
        label: "Daily spending pace",
        amount: -baselineDailySpend,
        kind: "baseline_spend",
      });
    }

    const delta = roundMoney(events.reduce((sum, event) => sum + event.amount, 0));
    balance = roundMoney(balance + delta);
    points.push({
      date: key,
      label: format(day, "MMM d"),
      balance,
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

  return {
    points,
    threshold,
    baselineDailySpend,
    lowestPoint,
    nextRiskDay: riskDays[0] ?? null,
    riskDays,
    nextPayday,
    upcomingEvents,
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
