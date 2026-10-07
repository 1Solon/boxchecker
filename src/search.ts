import { z } from "zod";

export type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  /** Full page text as markdown, only when pages were read. */
  content?: string;
};

export type Search = (query: string, options: { limit: number; readPages: boolean }) => Promise<SearchResult[]>;

const Response = z.object({
  data: z.object({
    web: z
      .array(
        z.object({
          url: z.string(),
          title: z.string().nullish(),
          description: z.string().nullish(),
          markdown: z.string().nullish(),
        }),
      )
      .default([]),
  }),
});

/** Firecrawl's `/v2/search`, which can also scrape each result page. */
export function firecrawlSearch(baseUrl: string): Search {
  return async (query, { limit, readPages }) => {
    const response = await fetch(`${baseUrl}/v2/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        limit,
        ...(readPages ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Search failed: ${response.status} ${await response.text()}`);
    return Response.parse(await response.json()).data.web.map((r) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: r.description ?? "",
      content: r.markdown ?? undefined,
    }));
  };
}

const STOPWORDS = new Set(
  "about after also been before being between both could does from have into just like many more most much only other over said some such than that their them then there these they this those very were what when where which while with would your".split(" "),
);

function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOPWORDS.has(w));
}

/**
 * Picks the paragraphs of a page that share the most keywords with the Claim,
 * keeping them in page order, up to `maxChars`.
 */
export function excerpt(page: string, claim: string, maxChars = 3000): string {
  const terms = keywords(claim);
  const paragraphs = page
    .split(/\n\s*\n/)
    .map((text, index) => {
      const words = new Set(keywords(text));
      return { text: text.trim(), index, score: terms.filter((t) => words.has(t)).length };
    })
    .filter((p) => p.score > 0 && p.text.length > 0);

  const chosen: typeof paragraphs = [];
  let length = 0;
  for (const p of [...paragraphs].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const text = p.text.length > maxChars ? p.text.slice(0, maxChars) : p.text;
    if (length + text.length > maxChars) continue;
    chosen.push({ ...p, text });
    length += text.length;
  }
  return chosen
    .sort((a, b) => a.index - b.index)
    .map((p) => p.text)
    .join("\n\n");
}
