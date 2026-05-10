import type { PushNotificationKind } from "./types";

export type PushNotificationKindMeta = {
  id: PushNotificationKind;
  label: string;
  hint: string;
};

/** Copy shown in Settings; server still substitutes placeholders when building push text. */
export const PUSH_NOTIFICATION_KIND_META: PushNotificationKindMeta[] = [
  { id: "bill_due_tomorrow", label: "Bill due tomorrow", hint: "[Bill], [amount]" },
  { id: "bill_due_today", label: "Bill due today", hint: "[Bill], [amount]" },
  { id: "over_budget", label: "Over daily budget", hint: "[amount]" },
  { id: "daily_allowance_morning", label: "Morning allowance", hint: "[amount]" },
  { id: "savings", label: "Savings pulse", hint: "[X], [amount]" },
  { id: "task_still_open", label: "Open task reminder", hint: "[task]" },
  { id: "morning_briefing", label: "Morning briefing", hint: "[X], [amount], [block], [time]" },
  { id: "streak_protect", label: "Streak protection", hint: "[X] (streak days)" },
  { id: "custom", label: "Custom / test pings", hint: "[message]; title may use default from sender" },
];
