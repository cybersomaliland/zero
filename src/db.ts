import Dexie, { type Table } from "dexie";
import type { CategoryRule, Settings, Subscription, Transaction } from "./types";

class ZeroDB extends Dexie {
  transactions!: Table<Transaction, number>;
  subscriptions!: Table<Subscription, number>;
  settings!: Table<Settings, number>;
  categoryRules!: Table<CategoryRule, number>;

  constructor() {
    super("zero_db");
    this.version(1).stores({
      transactions: "++id, date, type, category, createdAt",
      subscriptions: "++id, nextBillingDate, cycle, createdAt",
      settings: "id",
      categoryRules: "++id, keyword, category, updatedAt",
    });
    this.version(2)
      .stores({
        transactions: "++id, date, type, category, createdAt",
        subscriptions: "++id, nextBillingDate, cycle, createdAt",
        settings: "id",
        categoryRules: "++id, keyword, category, updatedAt",
      })
      .upgrade((tx) => {
        return tx.table("settings").toCollection().modify((setting) => {
          if (typeof setting.monthlySalary !== "number") {
            setting.monthlySalary = typeof setting.currentBalance === "number" ? setting.currentBalance : 0;
          }
        });
      });
  }
}

export const db = new ZeroDB();

const defaultRules = [
  { keyword: "coffee", category: "Food & Drink" },
  { keyword: "uber", category: "Transport" },
  { keyword: "salary", category: "Income" },
  { keyword: "netflix", category: "Subscriptions" },
  { keyword: "rent", category: "Housing" },
];

export async function seedIfEmpty() {
  const existingTx = await db.transactions.toArray();
  const existingSubs = await db.subscriptions.toArray();
  const hasLegacySampleTx =
    existingTx.length > 0 &&
    existingTx.length <= 3 &&
    existingTx.some((tx) => tx.note === "Main salary") &&
    existingTx.some((tx) => tx.note === "Coffee") &&
    existingTx.some((tx) => tx.note === "Uber");
  const hasLegacySampleSubs =
    existingSubs.length > 0 &&
    existingSubs.length <= 2 &&
    existingSubs.some((sub) => sub.name === "Netflix") &&
    existingSubs.some((sub) => sub.name === "Internet");

  // Clean old demo data from earlier app versions while preserving real user entries.
  if (hasLegacySampleTx) {
    await db.transactions.clear();
  }
  if (hasLegacySampleSubs) {
    await db.subscriptions.clear();
  }

  const hasSettings = await db.settings.get(1);
  if (!hasSettings) {
    await db.settings.put({
      id: 1,
      monthlySalary: 0,
      currentBalance: 0,
      reservedSavings: 0,
      monthlyTargets: { "Food & Drink": 300, Transport: 180, Subscriptions: 100 },
      categoryLimits: { "Food & Drink": 260, Transport: 150 },
    });
  }
  if ((await db.categoryRules.count()) === 0) {
    await db.categoryRules.bulkAdd(defaultRules.map((r) => ({ ...r, updatedAt: new Date().toISOString() })));
  }
}
