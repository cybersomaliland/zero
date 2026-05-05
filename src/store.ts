import { create } from "zustand";
import { db, seedIfEmpty } from "./db";
import { inferCategory } from "./logic";
import type { Settings, Subscription, Transaction } from "./types";

type State = {
  loading: boolean;
  transactions: Transaction[];
  subscriptions: Subscription[];
  settings: Settings | null;
  rules: { keyword: string; category: string }[];
  init: () => Promise<void>;
  addTransaction: (t: Omit<Transaction, "id" | "createdAt" | "category"> & { category?: string }) => Promise<void>;
  updateTransaction: (id: number, t: Partial<Transaction>) => Promise<void>;
  deleteTransaction: (id: number) => Promise<void>;
  addSubscription: (s: Omit<Subscription, "id" | "createdAt">) => Promise<void>;
  updateSettings: (s: Partial<Settings>) => Promise<void>;
  learnRule: (keyword: string, category: string) => Promise<void>;
  clearData: () => Promise<void>;
};

export const useZeroStore = create<State>((set, get) => ({
  loading: true,
  transactions: [],
  subscriptions: [],
  settings: null,
  rules: [],
  init: async () => {
    await seedIfEmpty();
    const [transactions, subscriptions, settings, rules] = await Promise.all([
      db.transactions.reverse().sortBy("date"),
      db.subscriptions.toArray(),
      db.settings.get(1),
      db.categoryRules.toArray(),
    ]);
    set({ transactions, subscriptions, settings: settings ?? null, rules, loading: false });
  },
  addTransaction: async (t) => {
    const { rules } = get();
    const inferred = inferCategory(`${t.note ?? ""} ${t.type}`, rules);
    const tx: Omit<Transaction, "id"> = {
      amount: t.amount,
      type: t.type,
      category: t.category || inferred || (t.type === "income" ? "Income" : "General"),
      note: t.note,
      date: t.date,
      createdAt: new Date().toISOString(),
    };
    await db.transactions.add(tx);
    await get().init();
  },
  updateTransaction: async (id, t) => {
    await db.transactions.update(id, t);
    await get().init();
  },
  deleteTransaction: async (id) => {
    await db.transactions.delete(id);
    await get().init();
  },
  addSubscription: async (s) => {
    await db.subscriptions.add({ ...s, createdAt: new Date().toISOString() });
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
  clearData: async () => {
    await Promise.all([
      db.transactions.clear(),
      db.subscriptions.clear(),
      db.settings.clear(),
      db.categoryRules.clear(),
    ]);
    await get().init();
  },
}));
