import { z } from "zod";
import { CONFIDENCES, VERDICTS, type Claim, type Verdict } from "./domain.ts";
import type { JsonModel } from "./llm.ts";
import { excerpt, type Search, type SearchResult } from "./search.ts";

export type Verifier = (claim: Pick<Claim, "text">) => Promise<Verdict>;

const Queries = z.object({ queries: z.array(z.string()).min(1) });

const Judgement = z.object({
  verdict: z.enum(VERDICTS),
  confidence: z.enum(CONFIDENCES),
  explanation: z.string(),
  important: z.boolean(),
  sources: z.array(z.number().int()),
});

const QUERIES_SYSTEM = `You write web search queries to fact-check a claim.
Write 1 to 3 short, specific queries that would find authoritative evidence for or against the claim.
Answer with JSON: {"queries": ["..."]}`;

const JUDGE_SYSTEM = `You fact-check a claim made in a spoken conversation, using only the numbered evidence provided.

Choose a verdict:
- "supported": the evidence confirms the claim.
- "refuted": the evidence contradicts the claim.
- "misleading": literally true, or partly true, but leaves a false impression (wrong context, wrong magnitude, cherry-picked).
- "unverifiable": the evidence is insufficient to decide. Never guess: if the evidence does not settle it, say unverifiable.

confidence: "high" only if the evidence is clear and from reliable sources; otherwise "medium" or "low".
explanation: one short sentence (under 25 words) stating what is actually true. Do not mention "the evidence" or "the speaker".
important: true if being wrong about this would matter to someone relying on it; false for trivial details.
sources: the numbers of the evidence items that support your verdict (at most 2, most authoritative first).

Answer with JSON: {"verdict": "...", "confidence": "...", "explanation": "...", "important": true|false, "sources": [1, 2]}`;

function evidencePrompt(claim: string, evidence: SearchResult[]): string {
  const items = evidence.map((e, i) => {
    const body = e.content ? excerpt(e.content, claim) || e.snippet : e.snippet;
    return `[${i + 1}] ${e.title} (${e.url})\n${body}`;
  });
  return `CLAIM: ${claim}\n\nEVIDENCE:\n${items.join("\n\n")}`;
}

function uniqueByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = seen.get(r.url);
    if (!existing || (!existing.content && r.content)) seen.set(r.url, r);
  }
  return [...seen.values()];
}

/**
 * Verification as fixed steps (ADR 0002): write queries, search, judge on
 * snippets, and read full pages only when snippets are not enough.
 */
export function pipelineVerifier(
  model: JsonModel,
  search: Search,
  { snippetsPerQuery = 5, pagesToRead = 3 } = {},
): Verifier {
  async function judge(claim: string, evidence: SearchResult[]) {
    const j = await model.json({ system: JUDGE_SYSTEM, user: evidencePrompt(claim, evidence), schema: Judgement });
    const sources = j.sources
      .map((n) => evidence[n - 1])
      .filter((e): e is SearchResult => e !== undefined)
      .slice(0, 2)
      .map(({ url, title }) => ({ url, title }));
    const { verdict, ...rest } = j;
    return { label: verdict, ...rest, sources };
  }

  return async ({ text }) => {
    const { queries } = await model.json({ system: QUERIES_SYSTEM, user: `CLAIM: ${text}`, schema: Queries });
    const top = queries.slice(0, 3);

    const snippets = uniqueByUrl(
      (await Promise.all(top.map((q) => search(q, { limit: snippetsPerQuery, readPages: false })))).flat(),
    );
    const first = await judge(text, snippets);
    if (first.label !== "unverifiable" && first.confidence !== "low") {
      return { ...first, readPages: false };
    }

    const pages = await search(top[0]!, { limit: pagesToRead, readPages: true });
    const second = await judge(text, uniqueByUrl([...pages, ...snippets]));
    return { ...second, readPages: true };
  };
}
