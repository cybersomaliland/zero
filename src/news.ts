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
  try {
    const xRes = await fetch("/api/x-brief", { signal });
    if (!xRes.ok) return [];
    const xData = await xRes.json() as { items?: NewsItem[] };
    return (xData.items ?? [])
      .map((item) => ({
        title: item.title,
        description: normalizeDescription(item.description),
        url: item.url,
        source: item.source || "X (Twitter)",
        publishedAt: item.publishedAt,
      }))
      .filter(isSomalilandRelevant)
      .slice(0, 3);
  } catch {
    return [];
  }
}
