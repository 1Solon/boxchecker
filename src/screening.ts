import { formatTime } from "./time.ts";
import { z } from "zod";
import type { Claim, Utterance } from "./domain.ts";
import type { JsonModel } from "./llm.ts";

export type ScreeningInput = {
  /** Recent Utterances for context, oldest first, ending with `utterance`. */
  context: Utterance[];
  /** The Utterance that just ended; only Claims made here are reported. */
  utterance: Utterance;
  /** Claims already found in this Conversation, so repeats are recognised. */
  knownClaims: Pick<Claim, "id" | "text">[];
};

export type ScreeningResult = {
  claims: { text: string; quote: string }[];
  repeats: { claimId: string; quote: string }[];
};

export type Screener = (input: ScreeningInput) => Promise<ScreeningResult>;

const Output = z.object({
  claims: z.array(
    z.object({
      quote: z.string(),
      claim: z.string(),
      repeat_of: z.string().nullable().optional(),
    }),
  ),
});

const SYSTEM = `You screen a live spoken conversation for claims worth fact-checking.

You are given a transcript excerpt. Only the LAST utterance is new; earlier lines are context.
Report the checkable claims made in the last utterance.

A claim is a specific assertion about the world that could be checked against public sources:
- a fact (dates, places, who did what, how something works)
- a statistic or number
- a quote or an attribution ("X said/wrote/argued Y")
- a report of a recent event

Never report:
- opinions, values, judgements, or recommendations
- predictions or hypotheticals
- statements about the speakers themselves or the people present
- statements about the conversation itself
- anything too vague to check

The transcript is automatic speech recognition: expect misheard names and filler words.
Restate each claim as one self-contained sentence a stranger could check without the conversation:
resolve pronouns and references using the context, and correct obvious mis-transcriptions of well-known names.

If a claim restates one of the KNOWN CLAIMS, set "repeat_of" to that claim's id; otherwise null.

Answer with JSON: {"claims": [{"quote": "<the words in the last utterance>", "claim": "<self-contained claim>", "repeat_of": "<id>" | null}]}
Most utterances contain no claims; then answer {"claims": []}.`;

export function screeningPrompt({ context, utterance, knownClaims }: ScreeningInput): string {
  const lines = context.map(
    (u) => `[${formatTime(u.start)}] ${u.speaker}${u.id === utterance.id ? " (LAST)" : ""}: ${u.text}`,
  );
  const known = knownClaims.length
    ? knownClaims.map((c) => `${c.id}: ${c.text}`).join("\n")
    : "(none)";
  return `KNOWN CLAIMS:\n${known}\n\nTRANSCRIPT:\n${lines.join("\n")}`;
}

export function modelScreener(model: JsonModel): Screener {
  return async (input) => {
    const known = new Set(input.knownClaims.map((c) => c.id));
    const { claims } = await model.json({ system: SYSTEM, user: screeningPrompt(input), schema: Output });

    const result: ScreeningResult = { claims: [], repeats: [] };
    for (const c of claims) {
      if (c.repeat_of && known.has(c.repeat_of)) result.repeats.push({ claimId: c.repeat_of, quote: c.quote });
      else result.claims.push({ text: c.claim, quote: c.quote });
    }
    return result;
  };
}
