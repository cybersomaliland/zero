import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDaysInMonth,
  isSameMonth,
  isSameWeek,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { buildCashflowForecast, type CashflowForecastResult } from "./cashflow";
import { inferCategoryFromText } from "./categories";
import type { CoachMemory, DailyContextNote, PlannedCashflowItem, RecurringIncome, SavingsGoal, Settings, Subscription, Transaction } from "./types";

const WEEK_STARTS_ON = 6; // Saturday
const AVG_DAYS_PER_MONTH = 30.4375;
const FLEXIBLE_CATEGORY_HINTS = [
  "food",
  "drink",
  "shopping",
  "entertainment",
  "fun",
  "travel",
  "transport",
  "personal",
  "beauty",
  "gifts",
  "lifestyle",
];

export type SavingsGoalTradeoffPlanKind = "aggressive_cut" | "balanced" | "subscription_cleanup";
export type SavingsGoalPlanConfidence = "high" | "medium" | "low";
export type SavingsGoalPlanBufferRisk = "low" | "medium" | "high";

export type SavingsGoalTradeoffPlan = {
  kind: SavingsGoalTradeoffPlanKind;
  label: string;
  summary: string;
  monthlyContribution: number;
  weeklyContribution: number;
  dailyContribution: number;
  projectedSaved: number;
  remainingGap: number;
  hitsGoal: boolean;
  estimatedGoalDate: string | null;
  confidence: SavingsGoalPlanConfidence;
  bufferRisk: SavingsGoalPlanBufferRisk;
  primaryMoves: string[];
};

export type SavingsGoalPlannerResult = {
  goal: SavingsGoal;
  daysLeft: number;
  monthsLeft: number;
  requiredMonthly: number;
  requiredWeekly: number;
  requiredDaily: number;
  currentMonthlyFreeCash: number;
  projectedNaturalSavings: number;
  topFlexibleCategories: Array<{ category: string; amount: number }>;
  topSubscriptionCandidates: Array<{ name: string; monthlyAmount: number }>;
  plans: SavingsGoalTradeoffPlan[];
};

export type AffordabilityAssessment = {
  amount: number;
  shortTermVerdict: "yes" | "tight" | "no";
  shortTermReason: string;
  safeToday: number;
  todayAfterPurchase: number;
  weekEndBalance: number | null;
  weekImpact: number;
  monthEndBalance: number | null;
  monthEndImpact: number;
  createsRiskDay: boolean;
  nextRiskDate: string | null;
  goal: {
    title: string;
    delayed: boolean;
    delayDays: number | null;
    currentGap: number;
    gapAfterPurchase: number;
  } | null;
};

export type MoneyMetricExplanationId =
  | "daily_safe_to_spend"
  | "cashflow_lowest_point"
  | "goal_gap";

export type MoneyMetricExplanation = {
  id: MoneyMetricExplanationId;
  title: string;
  summary: string;
  bullets: string[];
};

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function monthlySubscriptionAmount(sub: Subscription) {
  if (sub.cycle === "weekly") return sub.amount * (52 / 12);
  if (sub.cycle === "yearly") return sub.amount / 12;
  return sub.amount;
}

function isFlexibleCategory(category: string) {
  const normalized = category.trim().toLowerCase();
  return FLEXIBLE_CATEGORY_HINTS.some((hint) => normalized.includes(hint));
}

function buildGoalTransfers(
  goal: SavingsGoal,
  monthlyContribution: number,
  referenceDate: Date,
): PlannedCashflowItem[] {
  const start = startOfDay(referenceDate);
  const target = startOfDay(parseISO(goal.targetDate));
  const daysLeft = Math.max(1, differenceInCalendarDays(target, start));
  const totalPlanned = roundMoney((monthlyContribution / AVG_DAYS_PER_MONTH) * daysLeft);
  let remaining = totalPlanned;
  let cursor = startOfDay(addWeeks(start, 1));
  const rows: PlannedCashflowItem[] = [];
  while (cursor <= target && remaining > 0.01) {
    const chunk = roundMoney(Math.min(remaining, (monthlyContribution / AVG_DAYS_PER_MONTH) * 7));
    rows.push({
      title: `${goal.title} transfer`,
      amount: chunk,
      kind: "savings_transfer",
      date: format(cursor, "yyyy-MM-dd"),
      category: "Savings",
      createdAt: start.toISOString(),
    });
    remaining = roundMoney(remaining - chunk);
    cursor = startOfDay(addWeeks(cursor, 1));
  }
  if (remaining > 0.01) {
    rows.push({
      title: `${goal.title} final transfer`,
      amount: remaining,
      kind: "savings_transfer",
      date: format(target, "yyyy-MM-dd"),
      category: "Savings",
      createdAt: start.toISOString(),
    });
  }
  return rows;
}

function deriveBufferRisk(
  forecast: CashflowForecastResult,
  monthlyContribution: number,
): SavingsGoalPlanBufferRisk {
  const lowest = forecast.lowestPoint?.balance ?? forecast.points[forecast.points.length - 1]?.balance ?? 0;
  const cushion = lowest - forecast.threshold;
  if (forecast.nextRiskDay || cushion < 0) return "high";
  if (cushion < Math.max(35, monthlyContribution * 0.2)) return "medium";
  return "low";
}

function derivePlanConfidence(params: {
  hitsGoal: boolean;
  bufferRisk: SavingsGoalPlanBufferRisk;
  flexCut: number;
  subCut: number;
  flexibleMonthly: number;
  subscriptionMonthly: number;
}): SavingsGoalPlanConfidence {
  if (!params.hitsGoal) return "low";
  if (params.bufferRisk === "high") return "low";
  if (
    (params.flexibleMonthly > 0 && params.flexCut > params.flexibleMonthly * 0.42)
    || (params.subscriptionMonthly > 0 && params.subCut > params.subscriptionMonthly * 0.5)
  ) {
    return "medium";
  }
  return params.bufferRisk === "medium" ? "medium" : "high";
}

function pickPrimaryGoalPlan(planner: SavingsGoalPlannerResult) {
  return planner.plans.find((plan) => plan.kind === "balanced")
    ?? planner.plans.find((plan) => plan.hitsGoal)
    ?? planner.plans[0];
}

function extractQuestionAmount(question: string) {
  const match = question.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function looksLikeAffordabilityQuestion(question: string) {
  const q = question.toLowerCase();
  return q.includes("afford") || q.includes("buy this") || q.includes("buy it") || q.includes("can i buy");
}

export function buildMoneyMetricExplanations(params: {
  settings: Settings | null;
  transactions: Transaction[];
  subscriptions: Subscription[];
  recurringIncome: RecurringIncome[];
  plannedCashflows: PlannedCashflowItem[];
  activeGoal?: SavingsGoal | null;
  budgetSnapshot?: ReturnType<typeof computeBudgetSnapshot> | null;
  cashflowForecast?: CashflowForecastResult | null;
  goalPlanner?: SavingsGoalPlannerResult | null;
  referenceDate?: Date;
}): MoneyMetricExplanation[] {
  const {
    settings,
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    activeGoal = null,
  } = params;
  if (!settings) return [];

  const referenceDate = params.referenceDate ?? new Date();
  const budgetSnapshot = params.budgetSnapshot ?? computeBudgetSnapshot(transactions, subscriptions, settings, referenceDate);
  const cashflowForecast = params.cashflowForecast ?? buildCashflowForecast({
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    settings,
    horizonDays: 30,
    referenceDate,
  });
  const goalPlanner = params.goalPlanner ?? buildSavingsGoalPlanner({
    goal: activeGoal,
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    settings,
    referenceDate,
  });
  const upcomingBills = getUpcomingBills(subscriptions, Math.max(7, budgetSnapshot.daysLeftInWeek)).slice(0, 3);
  const dailyExplanation: MoneyMetricExplanation = {
    id: "daily_safe_to_spend",
    title: "Why is my safe-to-spend low today?",
    summary: `Today's room comes from ${money(settings.currentBalance)} current cash, minus ${money(budgetSnapshot.remainingMonthSubscriptions)} in bills still due this month, spread across ${budgetSnapshot.daysLeftInMonth} day(s), then reduced by ${money(budgetSnapshot.todaySpent)} already spent today.`,
    bullets: [
      `Current balance: ${money(settings.currentBalance)}.`,
      `Bills still due this month: ${money(budgetSnapshot.remainingMonthSubscriptions)}${upcomingBills.length > 0 ? ` (${upcomingBills.map((bill) => bill.name).join(", ")})` : ""}.`,
      `Daily allowance before today's spend: ${money(budgetSnapshot.dailyAllowance)} over ${budgetSnapshot.daysLeftInMonth} day(s) left this month.`,
      `Today's spend so far: ${money(budgetSnapshot.todaySpent)}, leaving ${money(Math.max(0, budgetSnapshot.todayRemaining))}.`,
    ],
  };

  const lowPoint = cashflowForecast.lowestPoint;
  const lowPointScheduledHits = (lowPoint?.events ?? [])
    .filter((event) => event.kind !== "baseline_spend")
    .slice(0, 3)
    .map((event) => `${event.label} ${money(event.amount)}`);
  const cashflowExplanation: MoneyMetricExplanation = {
    id: "cashflow_lowest_point",
    title: "Why does my cashflow dip there?",
    summary: lowPoint
      ? `The forecast bottoms at ${money(lowPoint.balance)} on ${format(parseISO(lowPoint.date), "MMM d")} after layering your daily spending pace of about ${money(cashflowForecast.baselineDailySpend)} with scheduled income, bills, and planned cash events.`
      : "There is no low point yet because the forecast does not have enough scheduled data to project a dip.",
    bullets: lowPoint
      ? [
        `Forecast starts from ${money(settings.currentBalance)} current balance.`,
        `Daily pace in the model: about ${money(cashflowForecast.baselineDailySpend)} per day.`,
        lowPointScheduledHits.length > 0
          ? `Scheduled hits around the low point: ${lowPointScheduledHits.join(", ")}.`
          : "The dip is mostly driven by normal daily spending pace rather than one large scheduled hit.",
        cashflowForecast.nextPayday
          ? `Next income after that: ${cashflowForecast.nextPayday.label} on ${format(parseISO(cashflowForecast.nextPayday.date), "MMM d")}.`
          : "No recurring payday is scheduled in the current forecast window.",
      ]
      : ["Add paydays, subscriptions, and planned cash items to get a fuller explanation here."],
  };

  const explanations = [dailyExplanation, cashflowExplanation];

  if (goalPlanner) {
    const goalGap = Math.max(0, goalPlanner.goal.targetAmount - goalPlanner.projectedNaturalSavings);
    explanations.push({
      id: "goal_gap",
      title: "Why is my goal gap this size?",
      summary: goalGap > 0
        ? `Your goal needs about ${money(goalPlanner.requiredMonthly)} per month, but your current natural free cash projects closer to ${money(goalPlanner.projectedNaturalSavings)} by the deadline, so the remaining gap is ${money(goalGap)}.`
        : `Your current path already covers the ${money(goalPlanner.goal.targetAmount)} target by the deadline, so there is no remaining gap right now.`,
      bullets: [
        `Goal target: ${money(goalPlanner.goal.targetAmount)} by ${format(parseISO(goalPlanner.goal.targetDate), "MMM d")}.`,
        `Required pace: ${money(goalPlanner.requiredMonthly)}/month or ${money(goalPlanner.requiredDaily)}/day.`,
        `Current free cash after observed spending: ${money(goalPlanner.currentMonthlyFreeCash)}/month.`,
        goalPlanner.topFlexibleCategories.length > 0
          ? `Biggest adjustable areas right now: ${goalPlanner.topFlexibleCategories.map((item) => `${item.category} ${money(item.amount)}`).join(", ")}.`
          : "There is not enough flexible spend history yet to suggest specific cut areas.",
      ],
    });
  }

  return explanations;
}

export function matchMoneyExplanationQuestion(
  question: string,
  explanations: MoneyMetricExplanation[],
): MoneyMetricExplanation | null {
  const q = question.toLowerCase();
  if (!q.includes("why")) return null;
  const byId = new Map(explanations.map((item) => [item.id, item]));
  if (/(safe[\s-]?to[\s-]?spend|daily allowance|money left today|safe per day|today.*low)/.test(q)) {
    return byId.get("daily_safe_to_spend") ?? null;
  }
  if (/(cashflow|lowest point|low point|forecast.*dip|risk day|low balance)/.test(q)) {
    return byId.get("cashflow_lowest_point") ?? null;
  }
  if (/(goal gap|extra to unlock|required monthly|saving goal|goal pace|why.*goal)/.test(q)) {
    return byId.get("goal_gap") ?? null;
  }
  return null;
}

export const money = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);

export const dayKey = (date: string) => format(parseISO(date), "yyyy-MM-dd");

export function computeBudgetSnapshot(
  transactions: Transaction[],
  subscriptions: Subscription[],
  settings: Settings,
  referenceDate = new Date(),
) {
  const nowDay = startOfDay(referenceDate);
  const monthKey = format(referenceDate, "yyyy-MM");
  const monthEnd = endOfMonth(referenceDate);
  const daysInMonth = Math.max(1, getDaysInMonth(referenceDate));
  const daysLeftInMonth = Math.max(1, differenceInCalendarDays(monthEnd, nowDay) + 1);
  const weekEnd = endOfWeek(referenceDate, { weekStartsOn: WEEK_STARTS_ON });
  const daysLeftInWeek = Math.max(1, differenceInCalendarDays(weekEnd, nowDay) + 1);

  const monthTransactions = transactions.filter((tx) => format(parseISO(tx.date), "yyyy-MM") === monthKey);
  const monthIncomeToDate = monthTransactions
    .filter((tx) => tx.type === "income" && parseISO(tx.date) <= referenceDate)
    .reduce((acc, tx) => acc + Math.abs(tx.amount), 0);
  const monthExpenseToDate = monthTransactions
    .filter((tx) => tx.type === "expense" && parseISO(tx.date) <= referenceDate)
    .reduce((acc, tx) => acc + Math.abs(tx.amount), 0);

  const remainingMonthSubscriptions = subscriptions.reduce((acc, sub) => {
    const due = parseISO(sub.nextBillingDate);
    if (due < nowDay || due > monthEnd) return acc;
    return acc + sub.amount;
  }, 0);

  const todayKey = format(referenceDate, "yyyy-MM-dd");
  const todaySpent = transactions
    .filter((tx) => tx.type === "expense" && format(parseISO(tx.date), "yyyy-MM-dd") === todayKey)
    .reduce((acc, tx) => acc + Math.abs(tx.amount), 0);
  const plannedIncomeRemaining = Math.max(0, settings.monthlySalary - monthIncomeToDate);
  // Treat currentBalance as the money basis the user entered in settings.
  const monthlyRealBalance = settings.currentBalance - remainingMonthSubscriptions;
  const dailyAllowance = Math.max(0, monthlyRealBalance / daysLeftInMonth);
  const weeklySafeToUse = Math.max(0, (settings.currentBalance / daysLeftInMonth) * Math.min(daysLeftInWeek, daysLeftInMonth));
  const todayRemaining = dailyAllowance - todaySpent;
  const weeklySpent = transactions
    .filter((tx) => tx.type === "expense" && isSameWeek(parseISO(tx.date), referenceDate, { weekStartsOn: WEEK_STARTS_ON }) && parseISO(tx.date) <= referenceDate)
    .reduce((acc, tx) => acc + Math.abs(tx.amount), 0);
  const weeklyIncome = transactions
    .filter((tx) => tx.type === "income" && isSameWeek(parseISO(tx.date), referenceDate, { weekStartsOn: WEEK_STARTS_ON }) && parseISO(tx.date) <= referenceDate)
    .reduce((acc, tx) => acc + Math.abs(tx.amount), 0);
  const weeklyUpcomingSubs = subscriptions.reduce((acc, sub) => {
    const due = parseISO(sub.nextBillingDate);
    const days = differenceInCalendarDays(due, nowDay);
    return days >= 0 && days <= daysLeftInWeek ? acc + sub.amount : acc;
  }, 0);

  return {
    currentBalance: settings.currentBalance,
    monthlyRealBalance,
    dailyAllowance,
    weeklySafeToUse,
    todaySpent,
    todayRemaining,
    weeklySpent,
    weeklyIncome,
    weeklyUpcomingSubs,
    daysInMonth,
    daysLeftInWeek,
    daysLeftInMonth,
    monthIncomeToDate,
    monthExpenseToDate,
    plannedIncomeRemaining,
    remainingMonthSubscriptions,
  };
}

export function inferCategory(input: string, rules: { keyword: string; category: string }[]) {
  const lowered = input.toLowerCase();
  const matchedRules = rules.filter((rule) => lowered.includes(rule.keyword.toLowerCase()));
  if (matchedRules.length > 0) {
    matchedRules.sort((a, b) => b.keyword.length - a.keyword.length);
    return matchedRules[0].category;
  }
  return inferCategoryFromText(input, "expense");
}

export function getDueStatus(date: string) {
  const days = differenceInCalendarDays(startOfDay(parseISO(date)), startOfDay(new Date()));
  if (days <= 3) return "due";
  if (days <= 10) return "soon";
  return "future";
}

/** Bills (subscriptions) with a due date in the current Saturday-start week. */
export function countSubscriptionsDueThisWeek(subscriptions: Subscription[], referenceDate = new Date()) {
  const weekStart = startOfWeek(referenceDate, { weekStartsOn: WEEK_STARTS_ON });
  const weekEnd = endOfWeek(referenceDate, { weekStartsOn: WEEK_STARTS_ON });
  return subscriptions.filter((sub) => {
    const due = startOfDay(parseISO(sub.nextBillingDate));
    return due >= weekStart && due <= weekEnd;
  }).length;
}

/** Calendar days from month start through today where daily allowance went negative. */
export function countOverBudgetDaysInMonth(
  transactions: Transaction[],
  subscriptions: Subscription[],
  settings: Settings,
  referenceDate = new Date(),
) {
  const monthStart = startOfMonth(referenceDate);
  const today = startOfDay(referenceDate);
  const monthEnd = endOfMonth(referenceDate);
  const intervalEnd = today <= monthEnd ? today : monthEnd;
  let count = 0;
  for (const d of eachDayOfInterval({ start: monthStart, end: intervalEnd })) {
    const snap = computeBudgetSnapshot(transactions, subscriptions, settings, d);
    if (snap.todayRemaining < 0) count += 1;
  }
  return count;
}

export function getUpcomingBills(subscriptions: Subscription[], days = 60) {
  return subscriptions
    .map((s) => ({
      ...s,
      dueDate: s.nextBillingDate,
      urgency: getDueStatus(s.nextBillingDate),
    }))
    .filter((s) => differenceInCalendarDays(parseISO(s.dueDate), new Date()) <= days)
    .sort((a, b) => +parseISO(a.dueDate) - +parseISO(b.dueDate));
}

export function calcSafeToSpend(settings: Settings, subscriptions: Subscription[]) {
  const dueSoon = getUpcomingBills(subscriptions, 30).reduce((acc, s) => acc + s.amount, 0);
  return settings.currentBalance - dueSoon - settings.reservedSavings;
}

export function generateInsights(transactions: Transaction[], subscriptions: Subscription[]) {
  const weekExpenses = transactions
    .filter((t) => t.type === "expense" && isSameWeek(parseISO(t.date), new Date(), { weekStartsOn: 1 }))
    .reduce((acc, t) => acc + Math.abs(t.amount), 0);
  const lastWeekExpenses = transactions
    .filter((t) => t.type === "expense" && isSameWeek(parseISO(t.date), addDays(new Date(), -7), { weekStartsOn: 1 }))
    .reduce((acc, t) => acc + Math.abs(t.amount), 0);
  const delta = lastWeekExpenses > 0 ? ((weekExpenses - lastWeekExpenses) / lastWeekExpenses) * 100 : 0;

  const monthSubCount = subscriptions.filter((s) => isSameMonth(parseISO(s.createdAt), new Date())).length;
  const items = [];
  if (Math.abs(delta) >= 10) {
    items.push(`You spent ${Math.abs(delta).toFixed(0)}% ${delta > 0 ? "more" : "less"} this week.`);
  }
  if (monthSubCount > 0) items.push(`Your subscriptions changed ${monthSubCount} time(s) this month.`);
  if (!items.length) items.push("Your spending rhythm looks steady this week.");
  return items;
}

export function forecast(
  transactions: Transaction[],
  subscriptions: Subscription[],
  recurringIncome: RecurringIncome[],
  plannedCashflows: PlannedCashflowItem[],
  settings: Settings,
  horizonDays = 30,
) {
  return buildCashflowForecast({
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    settings,
    horizonDays,
  }).points.map((point) => ({
    date: point.label,
    balance: point.balance,
  }));
}

export function buildSavingsGoalPlanner(params: {
  goal: SavingsGoal | null;
  transactions: Transaction[];
  subscriptions: Subscription[];
  recurringIncome: RecurringIncome[];
  plannedCashflows: PlannedCashflowItem[];
  settings: Settings | null;
  referenceDate?: Date;
}): SavingsGoalPlannerResult | null {
  const { goal, transactions, subscriptions, recurringIncome, plannedCashflows, settings } = params;
  if (!goal || !settings) return null;

  const referenceDate = params.referenceDate ?? new Date();
  const start = startOfDay(referenceDate);
  const target = startOfDay(parseISO(goal.targetDate));
  const rawDaysLeft = differenceInCalendarDays(target, start);
  if (!Number.isFinite(rawDaysLeft) || rawDaysLeft <= 0) return null;

  const daysLeft = Math.max(1, rawDaysLeft);
  const monthsLeft = Math.max(1 / AVG_DAYS_PER_MONTH, daysLeft / AVG_DAYS_PER_MONTH);
  const requiredDaily = roundMoney(goal.targetAmount / daysLeft);
  const requiredWeekly = roundMoney(requiredDaily * 7);
  const requiredMonthly = roundMoney(requiredDaily * AVG_DAYS_PER_MONTH);
  const horizonDays = Math.max(7, Math.min(180, daysLeft));
  const baseForecast = buildCashflowForecast({
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    settings,
    horizonDays,
    referenceDate,
  });
  const monthlyFreeCash = Math.max(0, baseForecast.salaryContext.monthlyNetAfterTransactions);
  const projectedNaturalSavings = roundMoney(monthlyFreeCash * monthsLeft);

  const topFlexibleCategories = Object.entries(
    transactions
      .filter((tx) => {
        if (tx.type !== "expense") return false;
        const txDate = parseISO(tx.date);
        const ageDays = differenceInCalendarDays(start, startOfDay(txDate));
        return ageDays >= 0 && ageDays <= 45 && isFlexibleCategory(tx.category);
      })
      .reduce<Record<string, number>>((acc, tx) => {
        acc[tx.category] = (acc[tx.category] || 0) + Math.abs(tx.amount);
        return acc;
      }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category, amount]) => ({ category, amount: roundMoney(amount) }));

  const topSubscriptionCandidates = subscriptions
    .map((sub) => ({ name: sub.name, monthlyAmount: roundMoney(monthlySubscriptionAmount(sub)) }))
    .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
    .slice(0, 3);

  const flexibleMonthly = Math.max(0, baseForecast.salaryContext.monthlyFlexibleSpend);
  const subscriptionMonthly = roundMoney(subscriptions.reduce((sum, sub) => sum + monthlySubscriptionAmount(sub), 0));

  const makePlan = (config: {
    kind: SavingsGoalTradeoffPlanKind;
    label: string;
    targetMonthly: number;
    flexibleCapRatio: number;
    subscriptionCapRatio: number;
  }): SavingsGoalTradeoffPlan => {
    const targetMonthly = roundMoney(Math.max(0, config.targetMonthly));
    const flexCap = roundMoney(flexibleMonthly * config.flexibleCapRatio);
    const subCap = roundMoney(subscriptionMonthly * config.subscriptionCapRatio);
    const baselineCarry = roundMoney(Math.min(targetMonthly, monthlyFreeCash));
    let remaining = roundMoney(Math.max(0, targetMonthly - baselineCarry));
    const flexCut = roundMoney(Math.min(remaining, flexCap));
    remaining = roundMoney(Math.max(0, remaining - flexCut));
    const subCut = roundMoney(Math.min(remaining, subCap));
    const plannedMonthly = roundMoney(baselineCarry + flexCut + subCut);
    const projectedSaved = roundMoney(plannedMonthly * monthsLeft);
    const remainingGap = roundMoney(Math.max(0, goal.targetAmount - projectedSaved));
    const hitsGoal = projectedSaved >= goal.targetAmount - 1;
    const dailyContribution = roundMoney(plannedMonthly / AVG_DAYS_PER_MONTH);
    const weeklyContribution = roundMoney(dailyContribution * 7);
    const estimatedGoalDate = plannedMonthly > 0
      ? format(addDays(start, Math.ceil(goal.targetAmount / Math.max(0.01, dailyContribution))), "yyyy-MM-dd")
      : null;
    const simulatedForecast = buildCashflowForecast({
      transactions,
      subscriptions,
      recurringIncome,
      plannedCashflows: [...plannedCashflows, ...buildGoalTransfers(goal, plannedMonthly, referenceDate)],
      settings,
      horizonDays,
      referenceDate,
    });
    const bufferRisk = deriveBufferRisk(simulatedForecast, plannedMonthly);
    const confidence = derivePlanConfidence({
      hitsGoal,
      bufferRisk,
      flexCut,
      subCut,
      flexibleMonthly,
      subscriptionMonthly,
    });
    const categoryHint = topFlexibleCategories.slice(0, 2).map((item) => item.category).join(" + ");
    const subHint = topSubscriptionCandidates.slice(0, 2).map((item) => item.name).join(" + ");
    const primaryMoves = [
      baselineCarry > 0 ? `Use ${money(baselineCarry)}/month from your current surplus.` : null,
      flexCut > 0
        ? `Trim about ${money(flexCut)}/month from flexible spend${categoryHint ? ` like ${categoryHint}` : ""}.`
        : null,
      subCut > 0
        ? `Clean up about ${money(subCut)}/month from subscriptions${subHint ? ` starting with ${subHint}` : ""}.`
        : null,
    ].filter((value): value is string => Boolean(value));
    const summary = hitsGoal
      ? `${money(projectedSaved)} by ${format(target, "MMM d")} with ${config.label.toLowerCase()} tradeoffs.`
      : `${money(projectedSaved)} by ${format(target, "MMM d")}, still ${money(remainingGap)} short unless income or cuts improve.`;

    return {
      kind: config.kind,
      label: config.label,
      summary,
      monthlyContribution: plannedMonthly,
      weeklyContribution,
      dailyContribution,
      projectedSaved,
      remainingGap,
      hitsGoal,
      estimatedGoalDate,
      confidence,
      bufferRisk,
      primaryMoves,
    };
  };

  return {
    goal,
    daysLeft,
    monthsLeft: roundMoney(monthsLeft),
    requiredMonthly,
    requiredWeekly,
    requiredDaily,
    currentMonthlyFreeCash: roundMoney(monthlyFreeCash),
    projectedNaturalSavings,
    topFlexibleCategories,
    topSubscriptionCandidates,
    plans: [
      makePlan({
        kind: "aggressive_cut",
        label: "Aggressive cut plan",
        targetMonthly: Math.min(requiredMonthly * 1.12, monthlyFreeCash + flexibleMonthly * 0.55 + subscriptionMonthly * 0.22),
        flexibleCapRatio: 0.55,
        subscriptionCapRatio: 0.22,
      }),
      makePlan({
        kind: "balanced",
        label: "Balanced plan",
        targetMonthly: Math.min(requiredMonthly, monthlyFreeCash + flexibleMonthly * 0.26 + subscriptionMonthly * 0.1),
        flexibleCapRatio: 0.26,
        subscriptionCapRatio: 0.1,
      }),
      makePlan({
        kind: "subscription_cleanup",
        label: "Subscription cleanup plan",
        targetMonthly: Math.min(requiredMonthly, monthlyFreeCash + flexibleMonthly * 0.12 + subscriptionMonthly * 0.65),
        flexibleCapRatio: 0.12,
        subscriptionCapRatio: 0.65,
      }),
    ],
  };
}

export function assessAffordability(params: {
  question: string;
  transactions: Transaction[];
  subscriptions: Subscription[];
  recurringIncome: RecurringIncome[];
  plannedCashflows: PlannedCashflowItem[];
  settings: Settings | null;
  activeGoal?: SavingsGoal | null;
  referenceDate?: Date;
}): AffordabilityAssessment | null {
  const amount = extractQuestionAmount(params.question);
  if (!amount || !params.settings) return null;

  const referenceDate = params.referenceDate ?? new Date();
  const settings = params.settings;
  const budget = computeBudgetSnapshot(params.transactions, params.subscriptions, settings, referenceDate);
  const safeToday = Math.max(0, budget.todayRemaining);
  const todayAfterPurchase = roundMoney(safeToday - amount);
  const horizonDays = Math.max(
    30,
    params.activeGoal
      ? Math.min(
        180,
        Math.max(30, differenceInCalendarDays(startOfDay(parseISO(params.activeGoal.targetDate)), startOfDay(referenceDate))),
      )
      : 30,
  );
  const purchaseCashflows: PlannedCashflowItem[] = [
    {
      title: "Affordability check purchase",
      amount,
      kind: "planned_expense",
      date: format(startOfDay(referenceDate), "yyyy-MM-dd"),
      category: "General",
      createdAt: referenceDate.toISOString(),
    },
  ];
  const purchaseForecast = buildCashflowForecast({
    transactions: params.transactions,
    subscriptions: params.subscriptions,
    recurringIncome: params.recurringIncome,
    plannedCashflows: [...params.plannedCashflows, ...purchaseCashflows],
    settings,
    horizonDays,
    referenceDate,
  });
  const weekEndKey = format(endOfWeek(referenceDate, { weekStartsOn: WEEK_STARTS_ON }), "yyyy-MM-dd");
  const monthEndKey = format(endOfMonth(referenceDate), "yyyy-MM-dd");
  const weekEndPoint = purchaseForecast.points.find((point) => point.date === weekEndKey) ?? null;
  const monthEndPoint = purchaseForecast.points.find((point) => point.date === monthEndKey) ?? purchaseForecast.points[purchaseForecast.points.length - 1] ?? null;
  const shortTermVerdict: AffordabilityAssessment["shortTermVerdict"] = todayAfterPurchase >= 0
    ? purchaseForecast.nextRiskDay
      ? "tight"
      : "yes"
    : "no";
  const shortTermReason = shortTermVerdict === "yes"
    ? `You stay within today's safe-to-spend and above your cash buffer.`
    : shortTermVerdict === "tight"
      ? `You can cover it today, but it pushes your forecast close to the buffer${purchaseForecast.nextRiskDay ? ` by ${format(parseISO(purchaseForecast.nextRiskDay.date), "MMM d")}` : ""}.`
      : `This is above today's safe-to-spend by ${money(Math.abs(todayAfterPurchase))}.`;

  let goal: AffordabilityAssessment["goal"] = null;
  if (params.activeGoal) {
    const baselinePlanner = buildSavingsGoalPlanner({
      goal: params.activeGoal,
      transactions: params.transactions,
      subscriptions: params.subscriptions,
      recurringIncome: params.recurringIncome,
      plannedCashflows: params.plannedCashflows,
      settings,
      referenceDate,
    });
    const adjustedPlanner = buildSavingsGoalPlanner({
      goal: {
        ...params.activeGoal,
        targetAmount: roundMoney(params.activeGoal.targetAmount + amount),
      },
      transactions: params.transactions,
      subscriptions: params.subscriptions,
      recurringIncome: params.recurringIncome,
      plannedCashflows: params.plannedCashflows,
      settings,
      referenceDate,
    });
    if (baselinePlanner && adjustedPlanner) {
      const baselinePlan = pickPrimaryGoalPlan(baselinePlanner);
      const adjustedPlan = pickPrimaryGoalPlan(adjustedPlanner);
      const delayDays = baselinePlan?.estimatedGoalDate && adjustedPlan?.estimatedGoalDate
        ? Math.max(
          0,
          differenceInCalendarDays(parseISO(adjustedPlan.estimatedGoalDate), parseISO(baselinePlan.estimatedGoalDate)),
        )
        : baselinePlanner.requiredDaily > 0
          ? Math.ceil(amount / baselinePlanner.requiredDaily)
          : null;
      goal = {
        title: params.activeGoal.title,
        delayed: (delayDays ?? 0) > 0 || adjustedPlanner.plans.every((plan) => !plan.hitsGoal),
        delayDays,
        currentGap: roundMoney(Math.max(0, params.activeGoal.targetAmount - baselinePlanner.projectedNaturalSavings)),
        gapAfterPurchase: roundMoney(Math.max(0, params.activeGoal.targetAmount + amount - adjustedPlanner.projectedNaturalSavings)),
      };
    }
  }

  return {
    amount,
    shortTermVerdict,
    shortTermReason,
    safeToday: roundMoney(safeToday),
    todayAfterPurchase,
    weekEndBalance: weekEndPoint ? roundMoney(weekEndPoint.balance) : null,
    weekImpact: roundMoney(-amount),
    monthEndBalance: monthEndPoint ? roundMoney(monthEndPoint.balance) : null,
    monthEndImpact: roundMoney(-amount),
    createsRiskDay: Boolean(purchaseForecast.nextRiskDay),
    nextRiskDate: purchaseForecast.nextRiskDay?.date ?? null,
    goal,
  };
}

export function nextDateFromCycle(date: string, cycle: Subscription["cycle"]) {
  const d = parseISO(date);
  if (cycle === "weekly") return addWeeks(d, 1).toISOString();
  if (cycle === "monthly") return addMonths(d, 1).toISOString();
  return addYears(d, 1).toISOString();
}

export function generateAiAdvice(transactions: Transaction[], subscriptions: Subscription[]) {
  const expenses = transactions.filter((t) => t.type === "expense");
  const byCategory = expenses.reduce<Record<string, number>>((acc, t) => {
    acc[t.category] = (acc[t.category] || 0) + Math.abs(t.amount);
    return acc;
  }, {});
  const topWaste = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
  const avgDaily = expenses.reduce((acc, t) => acc + Math.abs(t.amount), 0) / Math.max(1, expenses.length);
  const subTotal = subscriptions.reduce((acc, s) => acc + s.amount, 0);
  const notes: string[] = [];
  if (topWaste) notes.push(`Most of your spending goes to ${topWaste[0]} (${money(topWaste[1])}).`);
  if (avgDaily > 0) notes.push(`Your average daily spending is ${money(avgDaily)}. Reducing it by 10% can free up ${money(avgDaily * 30 * 0.1)} monthly.`);
  if (subTotal > 0) notes.push(`Subscriptions total ${money(subTotal)} per cycle. Reviewing one or two plans could improve your buffer.`);
  if (!notes.length) notes.push("Add a few transactions and I will generate tailored spending advice.");
  return notes;
}

export function askFinanceAssistant(
  question: string,
  transactions: Transaction[],
  subscriptions: Subscription[],
  recurringIncome: RecurringIncome[],
  plannedCashflows: PlannedCashflowItem[],
  settings: Settings,
  forecastData: Array<{ date: string; balance: number }>,
  activeGoal?: SavingsGoal | null,
  coachMemories: CoachMemory[] = [],
  dailyContextNotes: DailyContextNote[] = [],
) {
  const q = question.toLowerCase().trim();
  const scenario = simulateWhatIfScenario(question, transactions, subscriptions, settings);
  if (scenario) return scenario.reply;
  const moneyExplanations = buildMoneyMetricExplanations({
    settings,
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    activeGoal,
  });
  const matchedExplanation = matchMoneyExplanationQuestion(question, moneyExplanations);
  if (matchedExplanation) {
    return `${matchedExplanation.summary} ${matchedExplanation.bullets.join(" ")}`;
  }
  const expenses = transactions.filter((t) => t.type === "expense");
  const byCategory = expenses.reduce<Record<string, number>>((acc, t) => {
    acc[t.category.toLowerCase()] = (acc[t.category.toLowerCase()] || 0) + Math.abs(t.amount);
    return acc;
  }, {});
  const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
  const foodSpend = Object.entries(byCategory)
    .filter(([k]) => k.includes("food") || k.includes("drink"))
    .reduce((acc, [, v]) => acc + v, 0);
  const subTotal = subscriptions.reduce((acc, s) => acc + s.amount, 0);
  const minPoint = [...forecastData].sort((a, b) => a.balance - b.balance)[0];
  const latestAiVisibleNote = [...dailyContextNotes]
    .filter((note) => note.aiVisible && (note.body.trim() || note.title.trim()))
    .sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      return b.updatedAt.localeCompare(a.updatedAt);
    })[0] ?? null;
  const askedAmount = extractQuestionAmount(question);
  const affordability = assessAffordability({
    question,
    transactions,
    subscriptions,
    recurringIncome,
    plannedCashflows,
    settings,
    activeGoal,
  });

  if ((looksLikeAffordabilityQuestion(question) || q.includes("meal")) && askedAmount === null) {
    return `Yeah, let's figure it out — drop the price and I'll check it against today's safe-to-spend. Example: "Can I afford an $18 meal today?"`;
  }
  if (looksLikeAffordabilityQuestion(question) || q.includes("meal")) {
    const amount = askedAmount ?? 0;
    if (!affordability) {
      return `I need the price first. Example: "Can I afford a $25 meal today?"`;
    }
    const opener = affordability.shortTermVerdict === "yes"
      ? `Yes, ${money(amount)} fits today.`
      : affordability.shortTermVerdict === "tight"
        ? `You can buy it, but it's tight.`
        : `Not safely today.`;
    const weekLine = affordability.weekEndBalance != null
      ? `Week effect: about ${money(affordability.weekEndBalance)} left by week-end.`
      : `Week effect: this trims the next 7 days by ${money(amount)}.`;
    const monthLine = affordability.monthEndBalance != null
      ? `Month-end effect: about ${money(affordability.monthEndBalance)} left if the rest of the plan stays the same.`
      : `Month-end effect: roughly ${money(amount)} less room.`;
    const goalLine = affordability.goal
      ? affordability.goal.delayed
        ? `Goal effect: this likely pushes ${affordability.goal.title} back by about ${affordability.goal.delayDays ?? 0} day(s).`
        : `Goal effect: it doesn't materially delay ${affordability.goal.title} right now.`
      : `Goal effect: no active savings goal is set yet.`;
    return `${opener} Safe-to-spend now is ${money(affordability.safeToday)}, and after this you'd have ${money(affordability.todayAfterPurchase)} left today. ${weekLine} ${monthLine} ${goalLine}`;
  }
  if (q.includes("wasting") || q.includes("waste")) {
    if (!top) return "I need more expense data before I can detect waste patterns.";
    const memoryHint = coachMemories[0] ? ` Coach memory: ${coachMemories[0].summary}` : "";
    return `Your highest spend category is ${top[0]} at ${money(top[1])}. Start there by setting a softer weekly cap and checking recurring purchases.${memoryHint}`;
  }
  if (q.includes("food")) {
    return `You spent about ${money(foodSpend)} on food and drink based on your recorded transactions.`;
  }
  if (q.includes("subscription")) {
    return `Your current subscriptions total ${money(subTotal)} per billing cycle.`;
  }
  if (q.includes("predict") || q.includes("forecast") || q.includes("next")) {
    if (!minPoint) return "Add more data and I can forecast your next balance trend.";
    return `Your projected low point is around ${minPoint.date} at ${money(minPoint.balance)}. Consider trimming variable spend ahead of that date.`;
  }
  if ((q.includes("note") || q.includes("remember") || q.includes("what happened today")) && latestAiVisibleNote) {
    const titlePart = latestAiVisibleNote.title.trim() ? `${latestAiVisibleNote.title.trim()}: ` : "";
    const tagsPart = latestAiVisibleNote.tags.length > 0 ? ` Tags: ${latestAiVisibleNote.tags.join(", ")}.` : "";
    return `Your latest AI note from ${latestAiVisibleNote.date} says ${titlePart}${latestAiVisibleNote.body.trim()}.${tagsPart}`;
  }
  const memoryLine = coachMemories[0] ? ` I'm already tracking this pattern: ${coachMemories[0].summary}` : "";
  const noteLine = latestAiVisibleNote ? ` Latest note: ${latestAiVisibleNote.body.trim()}` : "";
  return `I'm tuned in once you point me at something — try e.g. "Can I afford a $25 meal today?", "Where's my money leaking?", food totals, or your next tight balance week.${memoryLine}${noteLine} What do you want to unpack first?`;
}

export function simulateWhatIfScenario(
  question: string,
  transactions: Transaction[],
  subscriptions: Subscription[],
  settings: Settings,
) {
  const q = question.toLowerCase();
  const asksWhatIf = q.includes("what if") || q.includes("if i") || q.includes("simulate") || q.includes("scenario");
  if (!asksWhatIf) return null;

  const thisMonth = format(new Date(), "yyyy-MM");
  const monthExpenses = transactions
    .filter((t) => t.type === "expense" && format(parseISO(t.date), "yyyy-MM") === thisMonth)
    .reduce<Record<string, number>>((acc, t) => {
      acc[t.category.toLowerCase()] = (acc[t.category.toLowerCase()] || 0) + Math.abs(t.amount);
      return acc;
    }, {});
  const monthExpenseTotal = Object.values(monthExpenses).reduce((sum, v) => sum + v, 0);
  const monthlySubTotal = subscriptions.reduce((sum, s) => {
    if (s.cycle === "weekly") return sum + s.amount * (52 / 12);
    if (s.cycle === "yearly") return sum + s.amount / 12;
    return sum + s.amount;
  }, 0);

  const cutMatch = q.match(/(?:cut|reduce|lower)\s+([a-z&\s]+?)\s+by\s+(\d{1,2})\s*%/i);
  let categoryCutName = "";
  let categoryCutPct = 0;
  let categoryCutSavings = 0;
  if (cutMatch) {
    categoryCutName = cutMatch[1].trim().toLowerCase();
    categoryCutPct = Math.min(90, Math.max(1, Number(cutMatch[2]) || 0));
    const matchedCategoryTotal = Object.entries(monthExpenses)
      .filter(([k]) => k.includes(categoryCutName))
      .reduce((sum, [, v]) => sum + v, 0);
    categoryCutSavings = matchedCategoryTotal * (categoryCutPct / 100);
  }

  let cancelSavings = 0;
  let canceledName = "";
  if (q.includes("cancel")) {
    const cancelMatch = q.match(/cancel\s+([a-z0-9&\s.'-]+)/i);
    const target = cancelMatch?.[1]?.trim().toLowerCase() ?? "";
    const matched = target
      ? subscriptions.find((s) => s.name.toLowerCase().includes(target))
      : null;
    if (matched) {
      canceledName = matched.name;
      if (matched.cycle === "weekly") cancelSavings = matched.amount * (52 / 12);
      else if (matched.cycle === "yearly") cancelSavings = matched.amount / 12;
      else cancelSavings = matched.amount;
    }
  }

  const totalSavings = categoryCutSavings + cancelSavings;
  const currentMonthEnd = settings.currentBalance - monthlySubTotal - monthExpenseTotal;
  const simulatedMonthEnd = currentMonthEnd + totalSavings;

  const changeNotes: string[] = [];
  if (categoryCutSavings > 0) {
    changeNotes.push(`Cut ${categoryCutName} by ${categoryCutPct}% -> saves about ${money(categoryCutSavings)}`);
  }
  if (cancelSavings > 0) {
    changeNotes.push(`Cancel ${canceledName} -> saves about ${money(cancelSavings)} monthly`);
  }
  if (changeNotes.length === 0) return null;

  const reply = [
    "Scenario simulator result:",
    ...changeNotes.map((n) => `- ${n}`),
    `Estimated month-end balance: ${money(simulatedMonthEnd)} (vs current path ${money(currentMonthEnd)}).`,
    `Net improvement: ${money(totalSavings)}.`,
    "If you want, I can run another what-if with different % cuts or a different subscription.",
  ].join("\n");

  return {
    reply,
    baseline: {
      currentMonthEnd,
      simulatedMonthEnd,
      totalSavings,
      changes: changeNotes,
    },
  };
}
