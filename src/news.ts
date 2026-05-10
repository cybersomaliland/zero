export type NewsItem = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt?: string;
};

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
      source: item.source || "X (Twitter)",
      publishedAt: item.publishedAt,
    }));
  const relevant = normalized.filter(isSomalilandRelevant);
  return (relevant.length > 0 ? relevant : normalized).slice(0, 3);
}
