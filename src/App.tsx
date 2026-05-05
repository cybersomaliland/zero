import { AnimatePresence, motion } from "framer-motion";
import { format, formatDistanceToNow, parseISO } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { askFinanceAssistant, calcSafeToSpend, forecast, generateAiAdvice, generateInsights, getUpcomingBills, money } from "./logic";
import { useZeroStore } from "./store";
import type { Subscription, SubscriptionCycle, TxType } from "./types";

const tabs = ["Home", "Transactions", "Subscriptions", "Insights", "Settings"] as const;
type Tab = (typeof tabs)[number];
const tabMeta: Record<Tab, { icon: string; label: string }> = {
  Home: { icon: "⌂", label: "Home" },
  Transactions: { icon: "↕", label: "Activity" },
  Subscriptions: { icon: "◌", label: "Subs" },
  Insights: { icon: "◔", label: "Insights" },
  Settings: { icon: "⚙", label: "Settings" },
};

const categories = ["Food & Drink", "Transport", "Subscriptions", "Shopping", "Housing", "Health", "Income", "General"];

function App() {
  const { loading, transactions, subscriptions, settings, init, addTransaction, deleteTransaction, updateTransaction, addSubscription, updateSubscription, addTransactionsBulk, updateSettings, clearData } = useZeroStore();
  const [tab, setTab] = useState<Tab>("Home");
  const [showTx, setShowTx] = useState(false);
  const [showSub, setShowSub] = useState(false);
  const [showBulkTx, setShowBulkTx] = useState(false);
  const [editingTx, setEditingTx] = useState<any | null>(null);
  const [editingSub, setEditingSub] = useState<Subscription | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQuestion, setAssistantQuestion] = useState("");
  const [chat, setChat] = useState<Array<{ role: "assistant" | "user"; text: string }>>([
    { role: "assistant", text: "I am your Zero AI assistant. Ask about spending, subscriptions, or future balance." },
  ]);
  const [notifState, setNotifState] = useState<"unsupported" | "default" | "granted" | "denied">(
    "default",
  );

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const safe = settings ? calcSafeToSpend(settings, subscriptions) : 0;
  const insights = useMemo(() => generateInsights(transactions, subscriptions), [transactions, subscriptions]);
  const upcoming = useMemo(() => getUpcomingBills(subscriptions), [subscriptions]);
  const forecastData = useMemo(() => (settings ? forecast(transactions, subscriptions, settings) : []), [transactions, subscriptions, settings]);
  const aiAdvice = useMemo(() => generateAiAdvice(transactions, subscriptions), [transactions, subscriptions]);
  const monthlyExpensesByCategory = useMemo(() => {
    const monthKey = format(new Date(), "yyyy-MM");
    return transactions
      .filter((t) => t.type === "expense" && format(parseISO(t.date), "yyyy-MM") === monthKey)
      .reduce<Record<string, number>>((acc, t) => {
        acc[t.category] = (acc[t.category] || 0) + Math.abs(t.amount);
        return acc;
      }, {});
  }, [transactions]);

  const refreshApp = async () => {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }
    }
    window.location.reload();
  };

  const enableNotifications = async () => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) {
      setNotifState("unsupported");
      return;
    }
    const permission = await Notification.requestPermission();
    setNotifState(permission as "default" | "granted" | "denied");
    if (permission !== "granted") return;

    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: "UPDATE_NOTIFICATION_DATA", payload: { upcomingCount: upcoming.length } });
    await registration.showNotification("Zero notifications enabled", {
      body: "We will remind you about upcoming bills and daily money check-ins.",
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "zero-enabled",
    });

    const periodic = (registration as ServiceWorkerRegistration & {
      periodicSync?: { register: (tag: string, options: { minInterval: number }) => Promise<void> };
    }).periodicSync;
    if (periodic?.register) {
      await periodic.register("zero-daily-check", { minInterval: 24 * 60 * 60 * 1000 });
    }
  };

  const testNotification = async () => {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("Zero reminder", {
      body: `You have ${upcoming.length} upcoming bill(s). Open Zero for details.`,
      icon: "/icon.svg",
      badge: "/icon.svg",
      tag: "zero-test",
    });
  };

  useEffect(() => {
    if (!("Notification" in window)) {
      setNotifState("unsupported");
      return;
    }
    setNotifState(Notification.permission as "default" | "granted" | "denied");
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then((registration) => {
      registration.active?.postMessage({
        type: "UPDATE_NOTIFICATION_DATA",
        payload: { upcomingCount: upcoming.length },
      });
    });
  }, [upcoming.length]);

  if (loading || !settings) return <div className="screen"><div className="skeleton large" /><div className="skeleton" /><div className="skeleton" /></div>;

  return (
    <div className="app-shell">
      <header className="top">
        <div>
          <p className="muted">Hello</p>
          <h1>Zero</h1>
        </div>
        <p className="muted">{format(new Date(), "EEEE, MMM d")}</p>
      </header>

      <main className="content">
        {tab === "Home" && (
          <>
            <section className="card main-card">
              <p className="muted">Safe to Spend</p>
              <h2>{money(safe)}</h2>
              <p className="muted">Balance {money(settings.currentBalance)} - Bills - Reserved savings</p>
            </section>
            <section className="card">
              <h3>Spending plan</h3>
              {Object.entries(settings.monthlyTargets).length === 0 && (
                <p className="muted">Set monthly targets in settings to see progress.</p>
              )}
              {Object.entries(settings.monthlyTargets).map(([category, target]) => {
                const spent = monthlyExpensesByCategory[category] || 0;
                const progress = Math.min(100, target > 0 ? (spent / target) * 100 : 0);
                return (
                  <div className="plan-row" key={category}>
                    <div className="row">
                      <strong>{category}</strong>
                      <span className="muted">{money(spent)} / {money(target)}</span>
                    </div>
                    <div className="plan-track">
                      <div className={`plan-fill ${progress >= 90 ? "warn" : ""}`} style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                );
              })}
            </section>
            <section className="card">
              <h3>Recent transactions</h3>
              {transactions.slice(0, 5).map((t) => <TransactionRow key={t.id} tx={t} onDelete={() => deleteTransaction(t.id!)} onEdit={() => { setEditingTx(t); setShowTx(true); }} />)}
            </section>
            <section className="card">
              <h3>Gentle insights</h3>
              {insights.map((i) => <p key={i} className="insight">{i}</p>)}
            </section>
          </>
        )}

        {tab === "Transactions" && (
          <section className="card">
            <div className="row">
              <h3>Transactions</h3>
              <div className="inline-actions">
                <button onClick={() => setShowBulkTx(true)}>Bulk add</button>
                <button onClick={() => setShowTx(true)}>Add</button>
              </div>
            </div>
            {transactions.map((t) => <TransactionRow key={t.id} tx={t} onDelete={() => deleteTransaction(t.id!)} onEdit={() => { setEditingTx(t); setShowTx(true); }} />)}
          </section>
        )}

        {tab === "Subscriptions" && (
          <section className="card">
            <div className="row"><h3>Subscriptions</h3><button onClick={() => setShowSub(true)}>Add</button></div>
            {upcoming.map((s) => (
              <SubscriptionRow
                key={s.id}
                label={s.name}
                amount={s.amount}
                date={s.dueDate}
                urgency={s.urgency}
                onEdit={() => {
                  setEditingSub(subscriptions.find((x) => x.id === s.id) ?? null);
                  setShowSub(true);
                }}
              />
            ))}
          </section>
        )}

        {tab === "Insights" && (
          <>
            <section className="card">
              <div className="row">
                <h3>AI-powered insights</h3>
                <span className="badge">Local AI</span>
              </div>
              {aiAdvice.map((tip) => <p key={tip} className="insight">{tip}</p>)}
            </section>
            <section className="card">
              <h3>Cash flow forecast (60 days)</h3>
              <div className="chart">
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={forecastData}>
                    <defs><linearGradient id="bal" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0A84FF" stopOpacity={0.45} /><stop offset="95%" stopColor="#0A84FF" stopOpacity={0.05} /></linearGradient></defs>
                    <XAxis dataKey="date" tickLine={false} axisLine={false} />
                    <YAxis tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="balance" stroke="#0A84FF" fill="url(#bal)" strokeWidth={3} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="card">
              <h3>Weekly snapshot</h3>
              <Snapshot transactions={transactions} settingsBalance={settings.currentBalance} />
            </section>
          </>
        )}

        {tab === "Settings" && (
          <section className="card">
            <h3>Settings</h3>
            <label>Current balance <input type="number" value={settings.currentBalance} onChange={(e) => updateSettings({ currentBalance: Number(e.target.value) })} /></label>
            <label>Reserved savings <input type="number" value={settings.reservedSavings} onChange={(e) => updateSettings({ reservedSavings: Number(e.target.value) })} /></label>
            <div className="inline-actions">
              <button type="button" onClick={() => { void enableNotifications(); }}>Enable notifications</button>
              <button type="button" className="ghost-btn" onClick={() => { void testNotification(); }} disabled={notifState !== "granted"}>
                Test notification
              </button>
            </div>
            <p className="muted">Notification status: {notifState}</p>
            <button type="button" onClick={() => { void refreshApp(); }}>Refresh app</button>
            <button
              className="danger-btn"
              type="button"
              onClick={async () => {
                const ok = window.confirm("Clear all local app data? This cannot be undone.");
                if (!ok) return;
                await clearData();
              }}
            >
              Clear data
            </button>
          </section>
        )}
      </main>

      <nav className="tabbar">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} aria-label={tabMeta[t].label}>
            <span className="tab-icon" aria-hidden="true">{tabMeta[t].icon}</span>
            <span className="tab-label">{tabMeta[t].label}</span>
          </button>
        ))}
      </nav>

      <AnimatePresence>
        {showTx && (
          <TransactionSheet
            initial={editingTx}
            onClose={() => { setShowTx(false); setEditingTx(null); }}
            onSave={async (payload) => {
              if (editingTx?.id) await updateTransaction(editingTx.id, payload);
              else await addTransaction(payload);
              setShowTx(false);
              setEditingTx(null);
            }}
          />
        )}
        {showSub && (
          <SubscriptionSheet
            initial={editingSub ?? undefined}
            onClose={() => { setShowSub(false); setEditingSub(null); }}
            onSave={async (payload) => {
              if (editingSub?.id) await updateSubscription(editingSub.id, payload);
              else await addSubscription(payload);
              setShowSub(false);
              setEditingSub(null);
            }}
          />
        )}
        {showBulkTx && (
          <BulkTransactionSheet
            onClose={() => setShowBulkTx(false)}
            onSave={async (rows) => {
              await addTransactionsBulk(rows);
              setShowBulkTx(false);
            }}
          />
        )}
      </AnimatePresence>

      <button className="ai-fab" type="button" onClick={() => setAssistantOpen((v) => !v)}>
        AI
      </button>
      <AnimatePresence>
        {assistantOpen && (
          <motion.section className="ai-chat" initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.96 }}>
            <div className="row">
              <h3>Zero Assistant</h3>
              <button type="button" onClick={() => setAssistantOpen(false)}>Close</button>
            </div>
            <div className="ai-chat-log">
              {chat.map((msg, i) => (
                <p key={`${msg.role}-${i}`} className={`ai-bubble ${msg.role}`}>
                  {msg.text}
                </p>
              ))}
            </div>
            <div className="assistant-input">
              <input
                value={assistantQuestion}
                onChange={(e) => setAssistantQuestion(e.target.value)}
                placeholder="Ask about your data..."
              />
              <button
                type="button"
                onClick={() => {
                  if (!assistantQuestion.trim()) return;
                  const question = assistantQuestion.trim();
                  const answer = askFinanceAssistant(question, transactions, subscriptions, settings, forecastData);
                  setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: answer }]);
                  setAssistantQuestion("");
                }}
              >
                Send
              </button>
            </div>
            <div className="assistant-quick">
              <button type="button" onClick={() => {
                const question = "Where am I wasting money?";
                const answer = askFinanceAssistant(question, transactions, subscriptions, settings, forecastData);
                setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: answer }]);
              }}>
                Waste check
              </button>
              <button type="button" onClick={() => {
                const question = "How much did I spend on food?";
                const answer = askFinanceAssistant(question, transactions, subscriptions, settings, forecastData);
                setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: answer }]);
              }}>
                Food spend
              </button>
              <button type="button" onClick={() => {
                const question = "Can I afford a $15 meal today?";
                const answer = askFinanceAssistant(question, transactions, subscriptions, settings, forecastData);
                setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: answer }]);
              }}>
                Can I afford $15 meal?
              </button>
              <button type="button" onClick={() => {
                const question = "Can I afford a $40 dinner today?";
                const answer = askFinanceAssistant(question, transactions, subscriptions, settings, forecastData);
                setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: answer }]);
              }}>
                Can I afford $40 dinner?
              </button>
              <button type="button" onClick={() => {
                const question = "How much are my subscriptions?";
                const answer = askFinanceAssistant(question, transactions, subscriptions, settings, forecastData);
                setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: answer }]);
              }}>
                Subscription total
              </button>
              <button type="button" onClick={() => {
                const question = "What is my next low balance point?";
                const answer = askFinanceAssistant(question, transactions, subscriptions, settings, forecastData);
                setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: answer }]);
              }}>
                Next low point
              </button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

function TransactionRow({ tx, onDelete, onEdit }: { tx: any; onDelete: () => void; onEdit: () => void }) {
  return (
    <motion.div className="tx-row" drag="x" dragConstraints={{ left: 0, right: 0 }} onDragEnd={(_, info) => { if (info.offset.x < -80) onDelete(); if (info.offset.x > 80) onEdit(); }}>
      <div><strong>{tx.category}</strong><p className="muted">{tx.note || "No note"}</p></div>
      <div className={tx.type === "income" ? "positive" : "negative"}>{money(tx.amount)}</div>
    </motion.div>
  );
}

function SubscriptionRow({ label, amount, date, urgency, onEdit }: { label: string; amount: number; date: string; urgency: string; onEdit: () => void }) {
  return (
    <div className={`urgency ${urgency}`}>
      <div><strong>{label}</strong><p>{formatDistanceToNow(parseISO(date), { addSuffix: true })}</p></div>
      <div className="inline-actions">
        <strong>{money(amount)}</strong>
        <button type="button" className="ghost-btn" onClick={onEdit}>Edit</button>
      </div>
    </div>
  );
}

function TransactionSheet({ initial, onClose, onSave }: { initial?: any; onClose: () => void; onSave: (p: { amount: number; type: TxType; category?: string; note?: string; date: string }) => Promise<void> }) {
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [type, setType] = useState<TxType>(initial?.type ?? "expense");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [date, setDate] = useState(initial ? format(parseISO(initial.date), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"));
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => { e.preventDefault(); onSave({ amount: Number(amount), type, category: category || undefined, note, date: new Date(date).toISOString() }); }}>
        <h3>{initial ? "Edit transaction" : "Quick transaction"}</h3>
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="-5 or 2000" required /></label>
        <label>Type<select value={type} onChange={(e) => setType(e.target.value as TxType)}><option value="expense">Expense</option><option value="income">Income</option></select></label>
        <label>Category<input value={category} onChange={(e) => setCategory(e.target.value)} list="categories" placeholder="Auto if empty" /></label>
        <datalist id="categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        <label>Note<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note" /></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save</button></div>
      </motion.form>
    </motion.div>
  );
}

function SubscriptionSheet({ initial, onClose, onSave }: { initial?: Subscription; onClose: () => void; onSave: (p: { name: string; amount: number; cycle: SubscriptionCycle; nextBillingDate: string }) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [cycle, setCycle] = useState<SubscriptionCycle>(initial?.cycle ?? "monthly");
  const [nextBillingDate, setNextBillingDate] = useState(initial ? format(parseISO(initial.nextBillingDate), "yyyy-MM-dd") : format(new Date(), "yyyy-MM-dd"));
  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form className="sheet" initial={{ y: 280 }} animate={{ y: 0 }} exit={{ y: 300 }} onSubmit={(e) => { e.preventDefault(); onSave({ name, amount: Number(amount), cycle, nextBillingDate: new Date(nextBillingDate).toISOString() }); }}>
        <h3>{initial ? "Edit subscription" : "Add subscription"}</h3>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
        <label>Cycle<select value={cycle} onChange={(e) => setCycle(e.target.value as SubscriptionCycle)}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        <label>Next billing<input type="date" value={nextBillingDate} onChange={(e) => setNextBillingDate(e.target.value)} /></label>
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save</button></div>
      </motion.form>
    </motion.div>
  );
}

function BulkTransactionSheet({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (rows: Array<{ amount: number; type: TxType; category?: string; note?: string; date: string }>) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  const parseRows = () => {
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((line, idx) => {
      const [amountRaw, typeRaw, categoryRaw, noteRaw, dateRaw] = line.split(",").map((x) => x?.trim());
      const amount = Number(amountRaw);
      const type = (typeRaw?.toLowerCase() ?? "") as TxType;
      const validType = type === "expense" || type === "income";
      const date = dateRaw ? new Date(dateRaw) : new Date();
      if (!Number.isFinite(amount) || !validType || Number.isNaN(date.getTime())) {
        throw new Error(`Line ${idx + 1} is invalid. Format: amount,type,category,note,YYYY-MM-DD`);
      }
      return {
        amount,
        type,
        category: categoryRaw || undefined,
        note: noteRaw || undefined,
        date: date.toISOString(),
      };
    });
    return parsed;
  };

  return (
    <motion.div className="sheet-wrap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.form
        className="sheet"
        initial={{ y: 280 }}
        animate={{ y: 0 }}
        exit={{ y: 300 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const rows = parseRows();
            await onSave(rows);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Invalid bulk input.");
          }
        }}
      >
        <h3>Bulk add transactions</h3>
        <p className="muted">One line each: amount,type,category,note,date</p>
        <textarea
          className="bulk-input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={"-5.5,expense,Food & Drink,Coffee,2026-05-05\n2200,income,Income,Salary,2026-05-01"}
          rows={7}
          required
        />
        {error && <p className="error-text">{error}</p>}
        <div className="row"><button type="button" onClick={onClose}>Cancel</button><button type="submit">Save all</button></div>
      </motion.form>
    </motion.div>
  );
}

function Snapshot({ transactions, settingsBalance }: { transactions: any[]; settingsBalance: number }) {
  const monthExpenses = transactions.filter((t) => t.type === "expense" && format(parseISO(t.date), "yyyy-MM") === format(new Date(), "yyyy-MM"));
  const totalSpent = monthExpenses.reduce((a, t) => a + Math.abs(t.amount), 0);
  const byCategory: Record<string, number> = monthExpenses.reduce(
    (acc: Record<string, number>, t) => ({ ...acc, [t.category]: (acc[t.category] || 0) + Math.abs(t.amount) }),
    {},
  );
  const topCategory = (Object.entries(byCategory) as [string, number][])
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "None yet";
  return (
    <div className="snapshot-grid">
      <article><p className="muted">Total spent</p><strong>{money(totalSpent)}</strong></article>
      <article><p className="muted">Top category</p><strong>{topCategory}</strong></article>
      <article><p className="muted">Remaining</p><strong>{money(settingsBalance - totalSpent)}</strong></article>
    </div>
  );
}

export default App;
