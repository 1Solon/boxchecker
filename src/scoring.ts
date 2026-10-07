import { z } from "zod";
import { VERDICTS, type Claim, type VerdictLabel } from "./domain.ts";
import type { JsonModel } from "./llm.ts";
import type { ReplayEvent } from "./replay.ts";
import { formatTime } from "./time.ts";

const Time = z.union([
  z.number(),
  z.string().regex(/^\d+:\d{2}$/).transform((t) => {
    const [m, s] = t.split(":").map(Number);
    return m! * 60 + s!;
  }),
]);

/** The answer key written next to a test recording: its Planted Claims. */
export const AnswerKey = z.object({
  claims: z.array(
    z.object({
      /** Roughly when the Claim is made, as m:ss or seconds. */
      at: Time,
      claim: z.string(),
      verdict: z.enum(VERDICTS),
      interject: z.boolean(),
    }),
  ),
});
export type AnswerKey = z.infer<typeof AnswerKey>;
export type PlantedClaim = AnswerKey["claims"][number];

/** Picks which found Claim, if any, is the Planted Claim. */
export type Matcher = (planted: PlantedClaim, candidates: Pick<Claim, "id" | "text">[]) => Promise<string | null>;

export function modelMatcher(model: JsonModel): Matcher {
  return async (planted, candidates) => {
    if (candidates.length === 0) return null;
    const { match } = await model.json({
      system: `You compare claims. Given a TARGET claim and numbered CANDIDATES found in a conversation, pick the candidate that asserts the same thing as the target (same subject and same assertion, even if worded differently or more or less precise). If none does, answer null.
Answer with JSON: {"match": "<candidate id>" | null}`,
      user: `TARGET: ${planted.claim}\n\nCANDIDATES:\n${candidates.map((c) => `${c.id}: ${c.text}`).join("\n")}`,
      schema: z.object({ match: z.string().nullable() }),
    });
    return candidates.some((c) => c.id === match) ? match : null;
  };
}

export type PlantedResult = {
  planted: PlantedClaim;
  claimId: string | null;
  verdict: VerdictLabel | null;
  interjected: boolean;
  /** Seconds from the Claim being said to its Verdict. */
  delay: number | null;
};

export type Score = {
  results: PlantedResult[];
  caught: number;
  verdictsRight: number;
  interjectionsRight: number;
  /** Found Claims that match no Planted Claim. */
  unplanted: Pick<Claim, "id" | "text">[];
  maxDelay: number | null;
};

/** Scores a Replay against an answer key, matching each Planted Claim to a found Claim within `window` seconds. */
export async function score(
  events: ReplayEvent[],
  key: AnswerKey,
  match: Matcher,
  { window = 30 } = {},
): Promise<Score> {
  const ends = new Map<string, number>();
  for (const e of events) if (e.type === "utterance") ends.set(e.utterance.id, e.utterance.end);
  const found = events.flatMap((e) => (e.type === "claim" ? [e.claim] : []));
  const saidAt = (c: Claim) => ends.get(c.utteranceIds.at(-1)!)!;
  const verdicts = new Map(events.flatMap((e) => (e.type === "verification" ? [[e.claimId, e] as const] : [])));
  const interjected = new Set(events.flatMap((e) => (e.type === "interjection" ? [e.claimId] : [])));

  const unmatched = new Map(found.map((c) => [c.id, c]));
  const results: PlantedResult[] = [];
  for (const planted of [...key.claims].sort((a, b) => a.at - b.at)) {
    const candidates = [...unmatched.values()].filter((c) => Math.abs(saidAt(c) - planted.at) <= window);
    const claimId = await match(planted, candidates.map(({ id, text }) => ({ id, text })));
    const claim = claimId ? unmatched.get(claimId) : undefined;
    if (claim) unmatched.delete(claim.id);
    const verification = claim ? verdicts.get(claim.id) : undefined;
    results.push({
      planted,
      claimId: claim?.id ?? null,
      verdict: verification?.verdict.label ?? null,
      interjected: claim ? interjected.has(claim.id) : false,
      delay: claim && verification ? verification.at - saidAt(claim) : null,
    });
  }

  const delays = results.flatMap((r) => (r.delay === null ? [] : [r.delay]));
  return {
    results,
    caught: results.filter((r) => r.claimId).length,
    verdictsRight: results.filter((r) => r.verdict === r.planted.verdict).length,
    interjectionsRight: results.filter((r) => r.interjected === r.planted.interject).length,
    unplanted: [...unmatched.values()].map(({ id, text }) => ({ id, text })),
    maxDelay: delays.length ? Math.max(...delays) : null,
  };
}

export function renderScore(s: Score, { delayBudget = 30 } = {}): string {
  const n = s.results.length;
  const pct = (k: number) => (n ? `${Math.round((100 * k) / n)}%` : "–");
  const lines = [
    "# Score",
    "",
    `- **Caught:** ${s.caught}/${n} (${pct(s.caught)})`,
    `- **Verdicts right:** ${s.verdictsRight}/${n} (${pct(s.verdictsRight)})`,
    `- **Interjection decisions right:** ${s.interjectionsRight}/${n} (${pct(s.interjectionsRight)})`,
    `- **Max delay:** ${s.maxDelay?.toFixed(1) ?? "–"}s (budget ${delayBudget}s)`,
    `- **Unplanted Claims found:** ${s.unplanted.length}`,
    "",
    "| At | Planted Claim | Expected | Found | Got | Interjected | Delay |",
    "|---|---|---|---|---|---|---|",
    ...s.results.map(
      (r) =>
        `| ${formatTime(r.planted.at)} | ${r.planted.claim} | ${r.planted.verdict}${r.planted.interject ? ", interject" : ""} | ${r.claimId ?? "**missed**"} | ${r.verdict ?? "–"}${r.verdict && r.verdict !== r.planted.verdict ? " ✗" : ""} | ${r.interjected ? "yes" : "no"}${r.interjected !== r.planted.interject ? " ✗" : ""} | ${r.delay === null ? "–" : `${r.delay.toFixed(1)}s${r.delay > delayBudget ? " ✗" : ""}`} |`,
    ),
    "",
    "## Unplanted Claims",
    "",
    "Review these by hand: each is either a real Claim missing from the answer key, or a Screening mistake.",
    "",
    ...(s.unplanted.length ? s.unplanted.map((c) => `- ${c.id}: ${c.text}`) : ["_None._"]),
    "",
  ];
  return lines.join("\n");
}
