export type TxType = "expense" | "income";

export type Transaction = {
  id?: number;
  amount: number;
  type: TxType;
  category: string;
  note?: string;
  date: string;
  createdAt: string;
};

export type SubscriptionCycle = "weekly" | "monthly" | "yearly";

export type Subscription = {
  id?: number;
  name: string;
  amount: number;
  cycle: SubscriptionCycle;
  nextBillingDate: string;
  createdAt: string;
};

export type RecurringIncomeCycle = "weekly" | "biweekly" | "monthly";

export type RecurringIncome = {
  id?: number;
  name: string;
  amount: number;
  cycle: RecurringIncomeCycle;
  nextDate: string;
  createdAt: string;
};

export type PlannedCashflowKind = "planned_expense" | "savings_transfer";

export type PlannedCashflowItem = {
  id?: number;
  title: string;
  amount: number;
  kind: PlannedCashflowKind;
  date: string;
  category?: string;
  createdAt: string;
};

export type SavingsGoal = {
  id?: number;
  title: string;
  targetAmount: number;
  targetDate: string;
  active: boolean;
  createdAt: string;
};

export type CoachMemoryKind =
  | "weekend_overspend"
  | "subscription_blindspot"
  | "post_payday_savings";

export type CoachMemory = {
  id?: number;
  kind: CoachMemoryKind;
  title: string;
  summary: string;
  evidence: string[];
  confidence: number;
  updatedAt: string;
  createdAt: string;
};

export type DailyContextNote = {
  id?: number;
  date: string;
  title: string;
  body: string;
  tags: string[];
  aiVisible: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Push types aligned with server `buildNotification` keys. */
export type PushNotificationKind =
  | "bill_due_tomorrow"
  | "bill_due_today"
  | "over_budget"
  | "daily_allowance_morning"
  | "savings"
  | "task_still_open"
  | "morning_briefing"
  | "streak_protect"
  | "water_reminder"
  | "custom";

/** Optional title/body overrides per push kind (placeholders same as server templates). */
export type PushNotificationMessageOverride = {
  title?: string;
  body?: string;
};

export type PushNotificationMessages = Partial<Record<PushNotificationKind, PushNotificationMessageOverride>>;

export type Settings = {
  id: number;
  profileName?: string;
  monthlySalary: number;
  currentBalance: number;
  reservedSavings: number;
  forecastRiskThreshold?: number;
  monthlyTargets: Record<string, number>;
  categoryLimits: Record<string, number>;
  /** Custom wording for web push; synced to server with notification context. */
  pushNotificationMessages?: PushNotificationMessages;
};

export type CategoryRule = {
  id?: number;
  keyword: string;
  category: string;
  updatedAt: string;
};
