import type {
  PlannedCashflowItem,
  RecurringIncome,
  Settings,
  Subscription,
  Transaction,
} from "./types";

function parseDateSafe(input: string) {
  const d = new Date(input);
  return Number.isFinite(d.getTime()) ? d : null;
}

export type AskTopic = "finance" | "routine" | "general" | "both";

export async function askGroqFinanceAssistant(params: {
  question: string;
  chatHistory: Array<{ role: "assistant" | "user"; text: string }>;
  /**
   * Controls which slices of user data are attached to the prompt.
   * - "finance": only money/bills/forecast context.
   * - "routine": only routine/timeline/checklist context.
   * - "general": minimal context (notes, memory, light routine).
   * - "both": finance + routine (e.g. "Plan my day").
   * Defaults to "general" if not provided.
   */
  topic?: AskTopic;
  transactions?: Transaction[];
  subscriptions?: Subscription[];
  recurringIncome?: RecurringIncome[];
  plannedCashflows?: PlannedCashflowItem[];
  settings?: Settings;
  forecastData?: Array<{ date: string; balance: number }>;
  cashflowForecastSummary?: {
    threshold: number;
    baselineDailySpend: number;
    salaryContext?: {
      monthlySalary: number;
      recurringSubscriptionsMonthly: number;
      salaryAfterSubscriptions: number;
      monthlyEssentialSpend: number;
      monthlyFlexibleSpend: number;
      monthlyObservedSpend: number;
      monthlyNetAfterTransactions: number;
    };
    spendingProfile?: {
      weekdayEssential: number;
      weekdayFlexible: number;
      weekendEssential: number;
      weekendFlexible: number;
    };
    lowestPoint: { date: string; balance: number } | null;
    nextRiskDay: { date: string; balance: number } | null;
    nextPayday: { date: string; label: string; amount: number } | null;
    riskDays: Array<{ date: string; balance: number }>;
    upcomingEvents: Array<{ date: string; label: string; amount: number; kind: string }>;
    checkpoints?: {
      nextPayday: { date: string; bestBalance: number; likelyBalance: number; worstBalance: number } | null;
      monthEnd: { date: string; bestBalance: number; likelyBalance: number; worstBalance: number } | null;
    };
    categoryTrends?: Array<{ category: string; changePct: number; direction: string; spendClass: string }>;
    requiredCorrection?: { amountPerDay: number; days: number; targetDate: string; targetLabel: string } | null;
    irregularExpenses?: Array<{ date: string; label: string; amount: number; category: string }>;
  };
  savingsGoalSummary?: {
    goal: { title: string; targetAmount: number; targetDate: string } | null;
    requiredMonthly?: number;
    projectedNaturalSavings?: number;
    plans?: Array<{
      kind: string;
      label: string;
      monthlyContribution: number;
      projectedSaved: number;
      remainingGap: number;
      hitsGoal: boolean;
      bufferRisk: string;
      confidence: string;
    }>;
  };
  metricExplanationSummary?: Array<{
    id: string;
    title: string;
    summary: string;
    bullets: string[];
  }>;
  decisionSummary?: {
    amount: number;
    shortTermVerdict: string;
    shortTermReason: string;
    safeToday: number;
    todayAfterPurchase: number;
    weekEndBalance: number | null;
    monthEndBalance: number | null;
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
  coachMemorySummary?: Array<{
    kind: string;
    title: string;
    summary: string;
    confidence: number;
    evidence: string[];
  }>;
  dailyNoteSummary?: Array<{
    date: string;
    title: string;
    body: string;
    tags: string[];
    aiVisible: boolean;
    updatedAt: string;
  }>;
  financeSnapshot?: {
    monthlySalary: number;
    currentBalance: number;
    monthlyRealBalance: number;
    weeklySafeToUse: number;
    dailyAllowance: number;
    todaySpent: number;
    todayRemaining: number;
    weeklySpent: number;
    weeklyIncome: number;
    weeklyUpcomingSubs: number;
  };
  routineSnapshot?: {
    userName: string;
    timeOfDay: "morning" | "afternoon" | "evening" | "night";
    currentBlock: { title: string; category: string; minutesLeft: number } | null;
    todayTimeline: Array<{ hour: number; title: string; category: string; durationMinutes?: number }>;
    checklist: {
      completedCount: number;
      totalCount: number;
      tasks: Array<{ title: string; priority: string; done: boolean }>;
    };
    templateBlocks: Array<{ hour: number; name: string; category: string; durationMinutes: number }>;
    planAhead: {
      tomorrow: Array<{ dayLabel: string; hour: number; title: string; category: string }>;
      laterThisWeek: Array<{ dayLabel: string; hour: number; title: string; category: string }>;
    };
    activeReminders: Array<{ label: string; delaySeconds: number; enabled: boolean }>;
  };
  onToken?: (chunk: string) => void;
  signal?: AbortSignal;
}) {
  const topic: AskTopic = params.topic ?? "general";
  const includeFinance = topic === "finance" || topic === "both";
  const includeRoutine = topic === "routine" || topic === "general" || topic === "both";
  const todayIso = new Date().toISOString().slice(0, 10);

  // ----- Finance computations & context -----
  const financeContext: Record<string, unknown> = {};
  if (includeFinance) {
    const transactions = params.transactions ?? [];
    const subscriptions = params.subscriptions ?? [];
    const recurringIncome = params.recurringIncome ?? [];
    const plannedCashflows = params.plannedCashflows ?? [];
    const forecastData = params.forecastData ?? [];
    const recentTransactions = [...transactions]
      .sort((a, b) => +new Date(b.date) - +new Date(a.date))
      .slice(0, 80);
    const upcomingSubscriptions = [...subscriptions]
      .sort((a, b) => +new Date(a.nextBillingDate) - +new Date(b.nextBillingDate))
      .slice(0, 40);
    const expenseTransactions = transactions.filter((t) => t.type === "expense");
    const spendingByCategory = expenseTransactions.reduce<Record<string, number>>((acc, tx) => {
      acc[tx.category] = (acc[tx.category] || 0) + Math.abs(tx.amount);
      return acc;
    }, {});
    const topSpendingCategories = Object.entries(spendingByCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, amount]) => ({ category, amount }));
    const recentIncomeTotal = transactions
      .filter((t) => t.type === "income")
      .slice(-20)
      .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const recentExpenseTotal = expenseTransactions.slice(-80).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(now.getDate() - 30);
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(now.getDate() - 60);
    const last30Expenses = expenseTransactions
      .filter((t) => {
        const d = parseDateSafe(t.date);
        return d ? d >= thirtyDaysAgo : false;
      })
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const prev30Expenses = expenseTransactions
      .filter((t) => {
        const d = parseDateSafe(t.date);
        return d ? d >= sixtyDaysAgo && d < thirtyDaysAgo : false;
      })
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const spendingTrend30dPct = prev30Expenses > 0
      ? Number((((last30Expenses - prev30Expenses) / prev30Expenses) * 100).toFixed(1))
      : null;
    const avgDailyExpense30d = Number((last30Expenses / 30).toFixed(2));
    const upcoming30dSubscriptions = subscriptions
      .filter((s) => {
        const d = parseDateSafe(s.nextBillingDate);
        if (!d) return false;
        const days = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        return days >= 0 && days <= 30;
      })
      .reduce((sum, s) => sum + s.amount, 0);
    const subscriptionsMonthlyRunRate = subscriptions.reduce((sum, s) => {
      if (s.cycle === "weekly") return sum + s.amount * 52 / 12;
      if (s.cycle === "yearly") return sum + s.amount / 12;
      return sum + s.amount;
    }, 0);
    const nearestForecastPoint = forecastData[0] ?? null;
    const lowestForecastPoint = [...forecastData].sort((a, b) => a.balance - b.balance)[0] ?? null;

    if (params.financeSnapshot) financeContext.financeSnapshot = params.financeSnapshot;
    if (params.settings) financeContext.settings = params.settings;
    financeContext.financialSummary = {
      transactionCount: transactions.length,
      subscriptionCount: subscriptions.length,
      recentIncomeTotal,
      recentExpenseTotal,
      topSpendingCategories,
    };
    financeContext.financialSignals = {
      avgDailyExpense30d,
      last30Expenses: Number(last30Expenses.toFixed(2)),
      previous30Expenses: Number(prev30Expenses.toFixed(2)),
      spendingTrend30dPct,
      upcoming30dSubscriptions: Number(upcoming30dSubscriptions.toFixed(2)),
      subscriptionsMonthlyRunRate: Number(subscriptionsMonthlyRunRate.toFixed(2)),
      nearestForecastPoint,
      lowestForecastPoint,
    };
    if (params.cashflowForecastSummary) {
      financeContext.cashflowForecast = {
        ...params.cashflowForecastSummary,
        recurringIncome: recurringIncome.slice(0, 12),
        plannedCashflows: plannedCashflows.slice(0, 20),
      };
    }
    if (params.savingsGoalSummary) financeContext.savingsGoal = params.savingsGoalSummary;
    if (params.metricExplanationSummary) financeContext.explainableMoneyMetrics = params.metricExplanationSummary;
    if (params.decisionSummary) financeContext.decisionAssistant = params.decisionSummary;
    financeContext.recentTransactions = recentTransactions;
    financeContext.upcomingSubscriptions = upcomingSubscriptions;
    financeContext.forecastData = forecastData.slice(0, 30);
  } else if (params.settings) {
    // Outside finance topic, only leak the profile name so the model can still address the user personally.
    financeContext.settings = { profileName: params.settings.profileName };
  }

  // ----- Routine computations & context -----
  const routineContext: Record<string, unknown> = {};
  let routineContextSummary = "";
  if (includeRoutine && params.routineSnapshot) {
    const r = params.routineSnapshot;
    const currentBlockLine = r.currentBlock
      ? `${r.currentBlock.title} (${r.currentBlock.category}), ${r.currentBlock.minutesLeft} min left`
      : "No activity scheduled right now";
    const timelineLine = r.todayTimeline.length > 0
      ? r.todayTimeline
        .slice(0, 12)
        .map((b) => {
          const h = b.hour > 12 ? `${b.hour - 12}pm` : b.hour === 12 ? "12pm" : `${b.hour}am`;
          return `${h} ${b.title} [${b.category}]`;
        })
        .join(" | ")
      : "No blocks scheduled today";
    const checklistLine = r.checklist.totalCount > 0
      ? `${r.checklist.completedCount}/${r.checklist.totalCount} done: ${r.checklist.tasks
        .slice(0, 8)
        .map((t) => `${t.done ? "done" : "open"} ${t.title} (${t.priority})`)
        .join("; ")}`
      : "No tasks in today's checklist";
    const templateLine = r.templateBlocks.length > 0
      ? r.templateBlocks
        .slice(0, 8)
        .map((b) => {
          const h = b.hour > 12 ? `${b.hour - 12}pm` : b.hour === 12 ? "12pm" : `${b.hour}am`;
          return `${h} ${b.name} (${b.durationMinutes}m, ${b.category})`;
        })
        .join(" | ")
      : "Routine template is empty";
    const tomorrowLine = r.planAhead.tomorrow.length > 0
      ? r.planAhead.tomorrow
        .slice(0, 6)
        .map((i) => `${i.dayLabel} ${i.hour > 12 ? `${i.hour - 12}pm` : i.hour === 12 ? "12pm" : `${i.hour}am`} ${i.title} (${i.category})`)
        .join(" | ")
      : "No plan-ahead items for tomorrow";
    const weekLine = r.planAhead.laterThisWeek.length > 0
      ? r.planAhead.laterThisWeek
        .slice(0, 6)
        .map((i) => `${i.dayLabel} ${i.hour > 12 ? `${i.hour - 12}pm` : i.hour === 12 ? "12pm" : `${i.hour}am`} ${i.title} (${i.category})`)
        .join(" | ")
      : "No plan-ahead items later this week";
    const remindersLine = r.activeReminders.length > 0
      ? r.activeReminders
        .slice(0, 6)
        .map((rem) => `${rem.label} in ${Math.max(1, Math.round(rem.delaySeconds / 60))}m (${rem.enabled ? "on" : "off"})`)
        .join(" | ")
      : "No active reminders";
    routineContextSummary = [
      `User: ${r.userName}. Time of day: ${r.timeOfDay}.`,
      `Current block: ${currentBlockLine}.`,
      `Today's timeline: ${timelineLine}.`,
      `Checklist: ${checklistLine}.`,
      `Template: ${templateLine}.`,
      `Plan ahead tomorrow: ${tomorrowLine}.`,
      `Plan ahead this week: ${weekLine}.`,
      `Reminders: ${remindersLine}.`,
    ].join("\n");
    routineContext.routineSnapshot = r;
    routineContext.routineContextSummary = routineContextSummary;
  }

  // ----- Response contract bullets — only keep the ones that match the topic. -----
  const baseBullets = [
    "Avoid assistant clichés and corporate phrases like 'Great question', 'I'm happy to help', 'Based on the data provided', or 'It appears that'.",
    "Lead with a verdict or judgment first.",
    "If information is missing for a reliable answer, ask one precise follow-up question.",
  ];
  const financeBullets = [
    "Use real numbers, categories, bills, and patterns when relevant.",
    "Show grounded empathy when finances feel tight, e.g. 'This does look tight' or 'The squeeze makes sense when food and bills hit together'.",
    "When coachMemory exists, use it naturally rather than constantly.",
    "Give one practical money-side next move when appropriate instead of generic filler.",
    "Do not invent transactions, balances, dates, subscriptions, income, events, or goals.",
  ];
  const routineBullets = [
    "Use the user's real routine blocks, tasks, checklist progress, and reminders when relevant.",
    "If routine context exists, focus on time, energy, and what to actually do next.",
    "Give one realistic next move tied to today's schedule when appropriate.",
    "Do not invent calendar blocks, tasks, reminders, or habits.",
  ];
  const sharedBullets = [
    "When dailyNotes exist, use them as stated user context about what happened, why it mattered, and what to remember next.",
  ];
  const responseContract: string[] = [...baseBullets, ...sharedBullets];
  if (includeFinance) responseContract.push(...financeBullets);
  if (includeRoutine) responseContract.push(...routineBullets);

  // ----- Assemble the context payload -----
  const context: Record<string, unknown> = {
    meta: {
      app: "Zero",
      today: todayIso,
      currency: "USD",
      topic,
    },
    understandingGuide: {
      definitions: includeFinance
        ? {
          currentBalance: "Real cash currently available in account.",
          monthlySalary: "Planned monthly income target.",
          monthlyRealBalance: "Current balance adjusted by this month's net flow and upcoming bills/savings.",
          weeklySafeToUse: "Recommended safe amount to use this week.",
        }
        : {},
      responseStyle:
        "Warm but not fake. Clear but not robotic. Smart but not overwhelming. Supportive without sounding soft, vague, or generic.",
      responseContract,
    },
    ...financeContext,
    ...routineContext,
  };

  if (params.coachMemorySummary) context.coachMemory = params.coachMemorySummary;
  if (params.dailyNoteSummary) context.dailyNotes = params.dailyNoteSummary;

  // ----- Scope hint appended to the user's question so the model also stays in lane. -----
  let scopedQuestion = params.question;
  if (topic === "finance") {
    scopedQuestion = `${params.question}\n\n[Scope: finance only — focus on money, bills, spending, and savings. Do not bring up calendar, routine, tasks, meals, or habits unless I asked directly.]`;
  } else if (topic === "routine") {
    scopedQuestion = `${params.question}\n\n[Scope: routine only — focus on the schedule, blocks, tasks, and habits. Do not bring up money, balance, bills, or spending unless I asked directly.]`;
  } else if (topic === "general") {
    scopedQuestion = `${params.question}\n\n[Scope: general — answer what I asked. Do not bring up finance numbers, bills, or spending unless I asked directly.]`;
  }

  const response = await fetch("/api/groq", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      question: scopedQuestion,
      chatHistory: params.chatHistory.slice(-10),
      context,
      stream: true,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const err = await response.json() as { error?: string; detail?: string };
      detail = err.detail || err.error || "";
    } catch {
      // ignore parse error
    }
    throw new Error(`Groq request failed: ${response.status}${detail ? ` - ${detail}` : ""}`);
  }

  if (!response.body) throw new Error("Groq stream unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    content += chunk;
    params.onToken?.(chunk);
  }
  content = content.trim();
  if (!content) throw new Error("Groq empty response");
  return content;
}
