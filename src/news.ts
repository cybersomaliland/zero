export type NewsItem = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt?: string;
};

const FALLBACK_KEY = "g-UpSttv40RqUFUc877PGn7mLj4Xof8PlcZZuCTr-hbh4l7P";
const NEWS_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_NEWS_API_KEY || FALLBACK_KEY;
const SOMALILAND_TERMS = ["somaliland", "hargeisa", "berbera", "borama"];

function normalizeDescription(value: unknown) {
  if (typeof value !== "string") return "No summary available.";
  return value.trim() || "No summary available.";
}

function isSomalilandRelevant(item: { title: string; description: string; source: string }) {
  const blob = `${item.title} ${item.description} ${item.source}`.toLowerCase();
  return SOMALILAND_TERMS.some((term) => blob.includes(term));
}

export async function fetchSomalilandNews(signal?: AbortSignal): Promise<NewsItem[]> {
  const attempts: Array<() => Promise<NewsItem[]>> = [
    async () => {
      const query = encodeURIComponent("Somaliland OR Hargeisa OR Berbera OR Borama");
      const url = `https://api.thenewsapi.com/v1/news/top?api_token=${encodeURIComponent(NEWS_KEY)}&search=${query}&language=en&limit=10`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`TheNewsAPI failed: ${res.status}`);
      const data = await res.json() as { data?: Array<{ title?: string; description?: string; url?: string; source?: string; published_at?: string }> };
      return (data.data ?? [])
        .filter((a) => !!a.title && !!a.url)
        .map((a) => ({
          title: a.title!,
          description: normalizeDescription(a.description),
          url: a.url!,
          source: a.source || "Somaliland News",
          publishedAt: a.published_at,
        }))
        .filter(isSomalilandRelevant);
    },
    async () => {
      const url = "https://api.currentsapi.services/v1/search?keywords=Somaliland,Hargeisa,Berbera,Borama&language=en";
      const res = await fetch(url, {
        signal,
        headers: { Authorization: NEWS_KEY },
      });
      if (!res.ok) throw new Error(`Currents failed: ${res.status}`);
      const data = await res.json() as { news?: Array<{ title?: string; description?: string; url?: string; author?: string; published?: string }> };
      return (data.news ?? [])
        .filter((a) => !!a.title && !!a.url)
        .map((a) => ({
          title: a.title!,
          description: normalizeDescription(a.description),
          url: a.url!,
          source: a.author || "Somaliland News",
          publishedAt: a.published,
        }))
        .filter(isSomalilandRelevant);
    },
  ];

  for (const attempt of attempts) {
    try {
      const items = await attempt();
      if (items.length > 0) return items.slice(0, 3);
    } catch {
      // try next provider
    }
  }

  return [];
}
