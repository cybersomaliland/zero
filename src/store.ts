import { create } from "zustand";
import { db, seedIfEmpty } from "./db";
import { inferCategory } from "./logic";
import { dedupeNormalizedTransactions, normalizeTransactionInput } from "./quality";
import type {
  PlannedCashflowItem,
  RecurringIncome,
  Settings,
  Subscription,
  Transaction,
} from "./types";

const signedTxAmount = (tx: Pick<Transaction, "type" | "amount">) => (tx.type === "income" ? 1 : -1) * Math.abs(Number(tx.amount) || 0);

type State = {
  loading: boolean;
  transactions: Transaction[];
  subscriptions: Subscription[];
  recurringIncome: RecurringIncome[];
  plannedCashflows: PlannedCashflowItem[];
  settings: Settings | null;
  rules: { keyword: string; category: string }[];
  init: () => Promise<void>;
  addTransaction: (t: Omit<Transaction, "id" | "createdAt" | "category"> & { category?: string }) => Promise<void>;
  updateTransaction: (id: number, t: Partial<Transaction>) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  addSubscription: (s: Omit<Subscription, "id" | "createdAt">) => Promise<void>;
  updateSubscription: (id: number, s: Partial<Subscription>) => Promise<void>;
  addRecurringIncome: (row: Omit<RecurringIncome, "id" | "createdAt">) => Promise<void>;
  updateRecurringIncome: (id: number, row: Partial<RecurringIncome>) => Promise<void>;
  deleteRecurringIncome: (id: number) => Promise<void>;
  addPlannedCashflow: (row: Omit<PlannedCashflowItem, "id" | "createdAt">) => Promise<void>;
  updatePlannedCashflow: (id: number, row: Partial<PlannedCashflowItem>) => Promise<void>;
  deletePlannedCashflow: (id: number) => Promise<void>;
  addTransactionsBulk: (rows: Array<Omit<Transaction, "id" | "createdAt" | "category"> & { category?: string }>) => Promise<void>;
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  learnRule: (keyword: string, category: string) => Promise<void>;
  recategorizeTransactions: () => Promise<void>;
  clearData: () => Promise<void>;
};

export const useZeroStore = create<State>((set, get) => ({
  loading: true,
  transactions: [],
  subscriptions: [],
  recurringIncome: [],
  plannedCashflows: [],
  settings: null,
  rules: [],
  init: async () => {
    await seedIfEmpty();
    const [transactions, subscriptions, recurringIncome, plannedCashflows, settings, rules] = await Promise.all([
      db.transactions.reverse().sortBy("date"),
      db.subscriptions.toArray(),
      db.recurringIncome.toArray(),
      db.plannedCashflows.toArray(),
      db.settings.get(1),
      db.categoryRules.toArray(),
    ]);
    recurringIncome.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
    plannedCashflows.sort((a, b) => a.date.localeCompare(b.date));
    set({
      transactions,
      subscriptions,
      recurringIncome,
      plannedCashflows,
      settings: settings ?? null,
      rules,
      loading: false,
    });
  },
  addTransaction: async (t) => {
    const clean = normalizeTransactionInput(t);
    const { rules } = get();
    const inferred = inferCategory(`${clean.note ?? ""} ${clean.category ?? ""} ${clean.type}`, rules);
    const tx: Omit<Transaction, "id"> = {
      amount: clean.amount,
      type: clean.type,
      category: clean.category || (clean.type === "income" ? "Income" : inferred),
      note: clean.note,
      date: clean.date,
      createdAt: new Date().toISOString(),
    };
    await db.transactions.add(tx);
    const settings = await db.settings.get(1);
    if (settings) {
      await db.settings.put({ ...settings, currentBalance: settings.currentBalance + signedTxAmount(tx), id: 1 });
    }
    await get().init();
  },
  updateTransaction: async (id, t) => {
    const prev = await db.transactions.get(id);
    await db.transactions.update(id, t);
    if (prev) {
      const settings = await db.settings.get(1);
      if (settings) {
        const nextTx = { ...prev, ...t };
        const delta = signedTxAmount(nextTx) - signedTxAmount(prev);
        if (delta !== 0) {
          await db.settings.put({ ...settings, currentBalance: settings.currentBalance + delta, id: 1 });
        }
      }
    }
    await get().init();
  },
  deleteTransaction: async (id) => {
    const prev = await db.transactions.get(id);
    await db.transactions.delete(id);
    if (prev) {
      const settings = await db.settings.get(1);
      if (settings) {
        await db.settings.put({ ...settings, currentBalance: settings.currentBalance - signedTxAmount(prev), id: 1 });
      }
    }
    await get().init();
  },
  addSubscription: async (s) => {
    await db.subscriptions.add({ ...s, createdAt: new Date().toISOString() });
    await get().init();
  },
  updateSubscription: async (id, s) => {
    await db.subscriptions.update(id, s);
    await get().init();
  },
  addRecurringIncome: async (row) => {
    await db.recurringIncome.add({ ...row, createdAt: new Date().toISOString() });
    await get().init();
  },
  updateRecurringIncome: async (id, row) => {
    await db.recurringIncome.update(id, row);
    await get().init();
  },
  deleteRecurringIncome: async (id) => {
    await db.recurringIncome.delete(id);
    await get().init();
  },
  addPlannedCashflow: async (row) => {
    await db.plannedCashflows.add({ ...row, createdAt: new Date().toISOString() });
    await get().init();
  },
  updatePlannedCashflow: async (id, row) => {
    await db.plannedCashflows.update(id, row);
    await get().init();
  },
  deletePlannedCashflow: async (id) => {
    await db.plannedCashflows.delete(id);
    await get().init();
  },
  addTransactionsBulk: async (rows) => {
    const { rules } = get();
    const normalizedRows = rows.map((t) => normalizeTransactionInput(t));
    const { unique } = dedupeNormalizedTransactions(normalizedRows);
    const prepared = unique.map((t) => {
      const inferred = inferCategory(`${t.note ?? ""} ${t.category ?? ""} ${t.type}`, rules);
      return {
        amount: t.amount,
        type: t.type,
        category: t.category || (t.type === "income" ? "Income" : inferred),
        note: t.note,
        date: t.date,
        createdAt: new Date().toISOString(),
      } as Omit<Transaction, "id">;
    });
    if (prepared.length > 0) {
      await db.transactions.bulkAdd(prepared);
      const settings = await db.settings.get(1);
      if (settings) {
        const delta = prepared.reduce((sum, tx) => sum + signedTxAmount(tx), 0);
        await db.settings.put({ ...settings, currentBalance: settings.currentBalance + delta, id: 1 });
      }
    }
    await get().init();
  },
  updateSettings: async (s) => {
    const current = get().settings;
    if (!current) return;
    await db.settings.put({ ...current, ...s, id: 1 });
    await get().init();
  },
  learnRule: async (keyword, category) => {
    await db.categoryRules.add({ keyword: keyword.toLowerCase(), category, updatedAt: new Date().toISOString() });
    await get().init();
  },
  recategorizeTransactions: async () => {
    const { rules } = get();
    const all = await db.transactions.toArray();
    for (const tx of all) {
      const inferred = tx.type === "income"
        ? "Income"
        : inferCategory(`${tx.note ?? ""} ${tx.category ?? ""} ${tx.type}`, rules);
      if (!tx.id || !inferred || inferred === tx.category) continue;
      await db.transactions.update(tx.id, { category: inferred });
    }
    await get().init();
  },
  clearData: async () => {
    await Promise.all([
      db.transactions.clear(),
      db.subscriptions.clear(),
      db.recurringIncome.clear(),
      db.plannedCashflows.clear(),
      db.settings.clear(),
      db.categoryRules.clear(),
    ]);
    await get().init();
  },
}));
