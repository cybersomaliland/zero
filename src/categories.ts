export type CategoryDefinition = {
  name: string;
  keywords: string[];
  color: {
    bg: string;
    text: string;
    ring: string;
  };
};

export const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  { name: "Food & Drink", keywords: ["food", "drink", "restaurant", "cafe", "coffee", "meal", "lunch", "dinner", "breakfast", "uber eats", "kfc", "pizza", "burger", "snack", "juice", "tea", "bakery", "take out", "takeout", "takeaway"], color: { bg: "#ffe9ea", text: "#b23442", ring: "#ffccd0" } },
  { name: "Groceries", keywords: ["grocery", "supermarket", "market", "aldi", "walmart", "carrefour", "fresh", "vegetable", "fruit", "household"], color: { bg: "#ecf8ea", text: "#2d7a36", ring: "#cdebc8" } },
  { name: "Transport", keywords: ["transport", "uber", "bolt", "taxi", "bus", "metro", "train", "fuel", "gas", "petrol", "diesel", "parking", "toll", "commute"], color: { bg: "#e8f3ff", text: "#1f5fbf", ring: "#cfe4ff" } },
  { name: "Car Care", keywords: ["car wash", "carcare", "car care", "wash", "detailing", "service", "car service", "repair", "mechanic", "oil change", "tire", "tyre", "battery"], color: { bg: "#e9f6ff", text: "#0d5f88", ring: "#cce9fb" } },
  { name: "Housing", keywords: ["rent", "housing", "home", "mortgage", "utility", "electricity", "water", "internet", "wifi"], color: { bg: "#f1edff", text: "#5840a6", ring: "#ddd4ff" } },
  { name: "Shopping", keywords: ["shopping", "mall", "amazon", "store", "clothes", "fashion", "shoes", "order", "electronics", "gadget", "accessory"], color: { bg: "#fff1e6", text: "#9a5817", ring: "#ffdcbc" } },
  { name: "Entertainment", keywords: ["movie", "cinema", "netflix", "spotify", "game", "music", "entertainment", "play"], color: { bg: "#ffeefe", text: "#9744a0", ring: "#f8d5fb" } },
  { name: "Health", keywords: ["health", "clinic", "hospital", "doctor", "pharmacy", "medicine", "gym", "fitness"], color: { bg: "#e8faf7", text: "#127a67", ring: "#c7eee6" } },
  { name: "Education", keywords: ["school", "course", "class", "book", "tuition", "learning", "training"], color: { bg: "#eef4ff", text: "#385cb9", ring: "#d8e4ff" } },
  { name: "Subscriptions", keywords: ["subscription", "monthly", "plan", "prime", "icloud", "adobe", "chatgpt", "youtube", "membership"], color: { bg: "#f2f2f7", text: "#4a4f5b", ring: "#e1e3ea" } },
  { name: "Bills", keywords: ["bill", "invoice", "payment", "due", "phone bill", "utility bill", "postpaid"], color: { bg: "#fff4e7", text: "#a25a08", ring: "#ffe2bd" } },
  { name: "Fees & Charges", keywords: ["fee", "charges", "commission", "interest", "penalty", "late fee", "bank fee", "atm fee"], color: { bg: "#fff0f2", text: "#a13654", ring: "#ffd6df" } },
  { name: "Savings", keywords: ["saving", "savings", "reserve", "deposit"], color: { bg: "#e6f7ff", text: "#0a6d93", ring: "#c8ecfb" } },
  { name: "Transfers", keywords: ["transfer", "send money", "cash out", "withdraw", "withdrawal", "bank transfer", "remit"], color: { bg: "#edf7ff", text: "#2d5f8b", ring: "#d5e9fb" } },
  { name: "Income", keywords: ["income", "salary", "pay", "wage", "bonus", "freelance", "client"], color: { bg: "#e6f9ed", text: "#1f7a3f", ring: "#c6ebd3" } },
  { name: "General", keywords: ["misc", "other", "general"], color: { bg: "#f3f4f6", text: "#4b5563", ring: "#e5e7eb" } },
];

export const CATEGORY_NAMES = CATEGORY_DEFINITIONS.map((c) => c.name);

export function getCategoryDefinition(category: string) {
  const direct = CATEGORY_DEFINITIONS.find((c) => c.name.toLowerCase() === category.toLowerCase());
  if (direct) return direct;
  return CATEGORY_DEFINITIONS.find((c) => c.name === "General")!;
}

export function inferCategoryFromText(input: string, type: "expense" | "income") {
  if (type === "income") return "Income";
  const text = input.toLowerCase();
  const normalized = text.replace(/[^a-z0-9\s]/g, " ");
  const compact = normalized.replace(/\s+/g, " ").trim();
  let best: { score: number; name: string } | null = null;
  for (const cat of CATEGORY_DEFINITIONS) {
    let score = 0;
    for (const keyword of cat.keywords) {
      const key = keyword.toLowerCase();
      if (compact.includes(key)) score += key.length > 6 ? 2 : 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { score, name: cat.name };
  }
  return best?.name ?? "General";
}
