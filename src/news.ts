export type NewsItem = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt?: string;
};

const SOMALILAND_TERMS = ["somaliland", "hargeisa", "berbera", "borama", "burao", "ceerigaabo", "las anod"];

function normalizeDescription(value: unknown) {
  if (typeof value !== "string") return "No summary available.";
  return value.trim() || "No summary available.";
}

function isSomalilandRelevant(item: { title: string; description: string; source: string }) {
  const blob = `${item.title} ${item.description} ${item.source}`.toLowerCase();
  return SOMALILAND_TERMS.some((term) => blob.includes(term));
}

export async function fetchSomalilandNews(signal?: AbortSignal): Promise<NewsItem[]> {
  let response: Response;
  try {
    response = await fetch("/api/x-brief", { signal });
  } catch {
    throw new Error("NEWS_NETWORK");
  }
  if (!response.ok) {
    throw new Error(`NEWS_HTTP_${response.status}`);
  }
  let xData: { items?: NewsItem[] };
  try {
    xData = (await response.json()) as { items?: NewsItem[] };
  } catch {
    throw new Error("NEWS_BAD_JSON");
  }
  const normalized = (xData.items ?? [])
    .map((item) => ({
      title: item.title,
      description: normalizeDescription(item.description),
      url: item.url,
      source: item.source || "X",
      publishedAt: item.publishedAt,
    }));
  const relevant = normalized.filter(isSomalilandRelevant);
  return [...(relevant.length > 0 ? relevant : normalized)]
    .sort((a, b) => {
      const ta = Date.parse(a.publishedAt || "");
      const tb = Date.parse(b.publishedAt || "");
      const safeA = Number.isFinite(ta) ? ta : 0;
      const safeB = Number.isFinite(tb) ? tb : 0;
      return safeB - safeA;
    })
    .slice(0, 8);
}
