import type { TxType } from "./types";

export type TransactionDraftInput = {
  amount: number;
  type: TxType;
  category?: string;
  note?: string;
  date: string;
};

export type TransactionQualitySnapshot = {
  score: number;
  grade: "high" | "medium" | "low";
  warnings: string[];
};

function cleanText(value?: string) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function toRoundedAmount(value: number) {
  return Number(Math.abs(value).toFixed(2));
}

export function normalizeTransactionInput(input: TransactionDraftInput): TransactionDraftInput {
  const amount = toRoundedAmount(Number(input.amount));
  const type = input.type;
  const parsedDate = new Date(input.date);
  const note = cleanText(input.note);
  const category = cleanText(input.category);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive number.");
  }
  if (type !== "income" && type !== "expense") {
    throw new Error("Type must be expense or income.");
  }
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error("Date is invalid.");
  }

  return {
    amount,
    type,
    category: category || undefined,
    note: note || undefined,
    date: parsedDate.toISOString(),
  };
}

export function getTransactionQualitySnapshot(input: TransactionDraftInput): TransactionQualitySnapshot {
  const warnings: string[] = [];
  const parsedDate = new Date(input.date);
  let score = 100;

  if (!input.note?.trim()) {
    warnings.push("Missing note");
    score -= 20;
  } else if ((input.note?.trim().length ?? 0) < 3) {
    warnings.push("Note is too short");
    score -= 8;
  }

  if (!input.category?.trim()) {
    warnings.push("Category will be auto-inferred");
    score -= 8;
  }

  const daysFromToday = Number.isNaN(parsedDate.getTime())
    ? 0
    : Math.round((parsedDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysFromToday > 45) {
    warnings.push("Date is far in the future");
    score -= 20;
  }
  if (daysFromToday < -400) {
    warnings.push("Date is very old");
    score -= 10;
  }

  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) {
    warnings.push("Amount is invalid");
    score -= 60;
  }

  score = Math.max(0, Math.min(100, score));
  const grade = score >= 85 ? "high" : score >= 60 ? "medium" : "low";
  return { score, grade, warnings };
}

export function dedupeNormalizedTransactions(rows: TransactionDraftInput[]) {
  const seen = new Set<string>();
  let duplicateCount = 0;
  const unique: TransactionDraftInput[] = [];

  for (const row of rows) {
    const d = new Date(row.date);
    const day = Number.isNaN(d.getTime()) ? row.date : d.toISOString().slice(0, 10);
    const key = [
      row.type,
      row.amount.toFixed(2),
      day,
      cleanText(row.note).toLowerCase(),
      cleanText(row.category).toLowerCase(),
    ].join("|");
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicateCount };
}

