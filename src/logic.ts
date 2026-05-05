import { addDays, addMonths, addWeeks, addYears, differenceInCalendarDays, format, isSameMonth, isSameWeek, parseISO, startOfDay } from "date-fns";
import { inferCategoryFromText } from "./categories";
import type { Settings, Subscription, Transaction } from "./types";

export const money = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);

export const dayKey = (date: string) => format(parseISO(date), "yyyy-MM-dd");

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

export function forecast(transactions: Transaction[], subscriptions: Subscription[], settings: Settings, horizonDays = 60) {
  const avgDaily = transactions
    .filter((t) => t.type === "expense")
    .reduce((acc, t) => acc + Math.abs(t.amount), 0) / Math.max(1, transactions.filter((t) => t.type === "expense").length);
  const recurringIncome = transactions.filter((t) => t.type === "income").reduce((acc, t) => acc + t.amount, 0) / 30;
  let balance = settings.currentBalance;

  const points = [];
  for (let i = 0; i <= horizonDays; i += 3) {
    const d = addDays(new Date(), i);
    const subCost = subscriptions.reduce((acc, s) => {
      const next = parseISO(s.nextBillingDate);
      const inWindow = differenceInCalendarDays(next, d) >= 0 && differenceInCalendarDays(next, d) <= 3;
      return acc + (inWindow ? s.amount : 0);
    }, 0);
    balance = balance + recurringIncome * 3 - avgDaily * 3 - subCost;
    points.push({ date: format(d, "MMM d"), balance: Number(balance.toFixed(2)) });
  }
  return points;
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
  settings: Settings,
  forecastData: Array<{ date: string; balance: number }>,
) {
  const q = question.toLowerCase().trim();
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
  const mealMatch = q.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  const askedAmount = mealMatch ? Number(mealMatch[1]) : null;
  const upcoming30 = getUpcomingBills(subscriptions, 30).reduce((acc, s) => acc + s.amount, 0);
  const safeToday = settings.currentBalance - settings.reservedSavings - upcoming30;

  if ((q.includes("afford") || q.includes("meal")) && askedAmount === null) {
    return `I can help with that. Tell me the meal price, for example: "Can I afford a $18 meal today?"`;
  }
  if (q.includes("afford") || q.includes("meal")) {
    const amount = askedAmount ?? 0;
    if (safeToday >= amount) {
      const afterPurchase = safeToday - amount;
      return `Yes, you can afford this today. Meal: ${money(amount)}. Safe-to-spend now: ${money(safeToday)}. After buying it, you still have about ${money(afterPurchase)} of safe spending room before planned bills and savings.`;
    }
    const firstAffordable = forecastData.find((p) => p.balance - settings.reservedSavings - upcoming30 >= amount);
    if (firstAffordable) {
      const idx = forecastData.indexOf(firstAffordable);
      const approxDays = idx * 3;
      return `Not today. Meal: ${money(amount)} and your safe-to-spend now is about ${money(safeToday)}. Based on your cash-flow trend, you can likely buy it in around ${approxDays} day(s) (near ${firstAffordable.date}) while staying within your buffer.`;
    }
    return `Not currently affordable with your present plan. Meal: ${money(amount)}, safe-to-spend now: ${money(safeToday)}. You may need to reduce variable spending or wait for the next income cycle.`;
  }
  if (q.includes("wasting") || q.includes("waste")) {
    if (!top) return "I need more expense data before I can detect waste patterns.";
    return `Your highest spend category is ${top[0]} at ${money(top[1])}. Start there by setting a softer weekly cap and checking recurring purchases.`;
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
  return "Try asking: 'Can I afford a $25 meal today?', 'Where am I wasting money?', 'How much did I spend on food?', or 'What is my next low balance point?'.";
}
