import { z } from "zod";
import type { Claim, InterjectionDecision, Utterance, Verdict } from "./domain.ts";
import type { JsonModel } from "./llm.ts";

/** Whether a Verdict is, on its own, worth interrupting the Conversation for. */
export function worthInterjecting(verdict: Verdict): InterjectionDecision {
  if (verdict.label !== "refuted" && verdict.label !== "misleading") return { interject: false, reason: "verdict" };
  if (verdict.confidence !== "high") return { interject: false, reason: "confidence" };
  if (!verdict.important) return { interject: false, reason: "unimportant" };
  return { interject: true };
}

export type InterjectionCandidate = {
  claimId: string;
  /** Conversation time the Verdict became available. */
  at: number;
  verdict: Verdict;
  /** Whether a Speaker had already corrected the Claim by `at`. */
  alreadyCorrected: boolean;
};

/**
 * Decides which Verifications become Interjections, in the order their
 * Verdicts arrive, allowing at most one Interjection per `minGap` seconds.
 */
export function decideInterjections(
  candidates: InterjectionCandidate[],
  { minGap = 120 } = {},
): Map<string, InterjectionDecision> {
  const decisions = new Map<string, InterjectionDecision>();
  let last: number | undefined;
  for (const c of [...candidates].sort((a, b) => a.at - b.at)) {
    const worth = worthInterjecting(c.verdict);
    if (!worth.interject) decisions.set(c.claimId, worth);
    else if (c.alreadyCorrected) decisions.set(c.claimId, { interject: false, reason: "already-corrected" });
    else if (last !== undefined && c.at - last < minGap) decisions.set(c.claimId, { interject: false, reason: "rate-limited" });
    else {
      decisions.set(c.claimId, { interject: true });
      last = c.at;
    }
  }
  return decisions;
}

const LABELS: Record<Verdict["label"], string> = {
  supported: "Supported",
  refuted: "Refuted",
  misleading: "Misleading",
  unverifiable: "Unverifiable",
};

/** One neutral line: Verdict first, the Claim, what is actually true, up to two Sources. Never names the Speaker. */
export function formatInterjection(claim: Pick<Claim, "text">, verdict: Verdict): string {
  const sources = verdict.sources
    .slice(0, 2)
    .map((s) => `[${s.title}](${s.url})`)
    .join(" · ");
  return `🔍 **${LABELS[verdict.label]}**: _"${claim.text}"_ ${verdict.explanation}${sources ? ` ${sources}` : ""}`;
}

/** Whether anyone in `later` already corrected the Claim. */
export type CorrectionCheck = (claim: Pick<Claim, "text">, verdict: Verdict, later: Utterance[]) => Promise<boolean>;

const Corrected = z.object({ corrected: z.boolean() });

export function modelCorrectionCheck(model: JsonModel): CorrectionCheck {
  return async (claim, verdict, later) => {
    if (later.length === 0) return false;
    const { corrected } = await model.json({
      system: `A claim was made in a conversation and fact-checked. Decide whether someone in the conversation has since corrected it or disputed it with the right information, so a fact-check would be redundant.
Answer with JSON: {"corrected": true|false}`,
      user: `CLAIM: ${claim.text}\nFACT-CHECK: ${verdict.label}. ${verdict.explanation}\n\nLATER IN THE CONVERSATION:\n${later.map((u) => `${u.speaker}: ${u.text}`).join("\n")}`,
      schema: Corrected,
    });
    return corrected;
  };
}
