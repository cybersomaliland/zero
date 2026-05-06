# Zero

Zero is a mobile-first personal operating system for money and daily discipline.
It combines personal finance tracking, subscription planning, daily routines, AI coaching, and Somaliland headline briefings in one app.

## What This App Can Do

### Finance
- Track income and expenses with category, note, and date.
- Auto-categorize transactions using smart keyword/category inference.
- Add transactions in bulk using CSV-like line input.
- Edit/delete transactions quickly (including swipe gestures).
- Maintain recurring subscriptions (weekly/monthly/yearly) with urgency states (`due`, `soon`, `future`).
- Calculate:
  - weekly safe-to-use amount
  - monthly real balance
  - daily allowance target
  - day-by-day spending breakdown
- Show spending calendar for the current month and a day-level detail sheet with improvement suggestions.
- Forecast cash flow trend over time from transactions + recurring bills.

### Routine + Productivity
- Morning ritual flow (5-step guided planning):
  - yesterday review
  - top 3 priorities
  - daily intention
  - distractions to avoid
  - energy rating
- Visual timeline planner (6am-10pm) with category tags (`work`, `health`, `personal`) and current-hour indicator.
- Pattern memory from yesterday (repeat recommendations).
- Task manager with:
  - priorities (`high`, `medium`, `low`)
  - category tags
  - filters (`all`, `open`, `done`)
- Meal planner with planned/done toggles and calorie tracking.
- End-of-day shutdown with reflections, day score, and close-day state.

### AI + Guidance
- Built-in Coach Zero chat assistant (floating action button).
- Groq-backed personalized advice via backend proxy (`/api/groq`).
- Local fallback assistant when Groq is unavailable.
- Quick prompts for daily plan, meal checks, and spending cautions.
- Morning briefing modal with:
  - money, tasks, meals, timeline context
  - coach suggestions
  - one-tap AI follow-ups

### News + Context
- Pull Somaliland-relevant headlines from:
  - X/Nitter RSS mirrors
  - Google News RSS
  - TheNewsAPI fallback
- Filter for Somaliland-focused keywords.
- Dedupe and surface latest/hot headline cards.

### PWA + Reliability
- Service worker registration and update handling.
- In-app refresh tooling to clear caches and force latest build.
- Browser notifications support:
  - permission flow
  - test notification
  - upcoming-bills context updates
- Local-first persistence for finance data (IndexedDB) and routine/chat state (localStorage).

## Product Design

### UX Direction
- iOS-inspired, card-based UI with rounded surfaces and soft shadows.
- Single-column, thumb-friendly mobile layout (`max-width ~430px`).
- Bottom tab navigation with 5 core areas:
  - Home
  - Transactions
  - Subscriptions
  - Insights
  - Settings
- Progressive disclosure for sensitive amounts (tap-to-reveal balance fields).

### Home Experience
- Focuses on "what matters now":
  - streak
  - today summary
  - top money numbers
  - daily allowance status
  - recent transactions
  - spending calendar

### Behavioral Design
- Uses soft nudges rather than strict warnings.
- Encourages consistency via streaks and daily closure.
- Blends financial and personal routines in one flow to improve execution, not just tracking.

## Technical Design

### Frontend
- React 19 + TypeScript + Vite.
- State management: Zustand.
- Local database: Dexie (IndexedDB).
- Motion/transitions: Framer Motion.
- Date calculations: date-fns.

### Backend
- Express server (`server.js`) serves:
  - static production build (`dist`)
  - API endpoints for AI and news:
    - `POST /api/groq`
    - `GET /api/x-brief`
    - `GET /api/news-brief`

### Data Model
- Core entities:
  - `Transaction`
  - `Subscription`
  - `Settings`
  - `CategoryRule`
- DB versioned migrations handle settings evolution safely.

### Storage Strategy
- IndexedDB (Dexie): durable app data.
- localStorage: UI/session data like routine snapshot, routine history, and AI chat history.

## Getting Started

## 1) Install dependencies
```bash
npm install
```

## 2) Configure environment
Copy `.env.example` to `.env` and set:

```env
GROQ_API_KEY=your_groq_api_key_here
VITE_NEWS_API_KEY=your_news_api_key_here
VAPID_PUBLIC_KEY=your_vapid_public_key_here
VAPID_PRIVATE_KEY=your_vapid_private_key_here
VAPID_SUBJECT=mailto:you@example.com
```

Generate VAPID keys once:
```bash
npx web-push generate-vapid-keys
```

## 3) Run in development
```bash
npm run dev
```

## 4) Build for production
```bash
npm run build
```

## 5) Run production server
```bash
npm run start
```

## Scripts
- `npm run dev` - start Vite dev server
- `npm run build` - type-check and build app
- `npm run preview` - preview Vite production build
- `npm run start` - run Express server (`server.js`)

## Notes
- The app is local-first by design; data stays on the device/browser unless external APIs are requested (AI/news).
- Notifications, service workers, and periodic sync support depend on browser capabilities and permissions.
