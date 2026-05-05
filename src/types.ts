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

export type Settings = {
  id: number;
  currentBalance: number;
  reservedSavings: number;
  monthlyTargets: Record<string, number>;
  categoryLimits: Record<string, number>;
};

export type CategoryRule = {
  id?: number;
  keyword: string;
  category: string;
  updatedAt: string;
};
