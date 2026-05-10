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
