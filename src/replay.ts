import type { Claim, InterjectionDecision, Transcript, Utterance, Verdict } from "./domain.ts";
import { decideInterjections, formatInterjection, worthInterjecting, type CorrectionCheck } from "./interjection.ts";
import type { Screener } from "./screening.ts";
import type { Verifier } from "./verification.ts";

/** Everything a Replay observed, each stamped with the Conversation time (`at`, seconds) it would have happened live. */
export type ReplayEvent =
  | { type: "utterance"; at: number; utterance: Utterance }
  | { type: "claim"; at: number; claim: Claim; screeningSeconds: number }
  | { type: "repeat"; at: number; claimId: string; utteranceId: string; quote: string }
  | { type: "verification"; at: number; claimId: string; verdict: Verdict; verificationSeconds: number }
  | { type: "decision"; at: number; claimId: string; decision: InterjectionDecision }
  | { type: "interjection"; at: number; claimId: string; text: string }
  | { type: "error"; at: number; stage: "screening" | "verification"; subject: string; message: string };

export type ReplayDeps = {
  screen: Screener;
  verify: Verifier;
  checkCorrected: CorrectionCheck;
  /** Monotonic wall-clock seconds, used to measure how long each stage takes. */
  clock?: () => number;
  /** Seconds of transcription delay to assume between speech ending and its Utterance existing. */
  transcriptionDelay?: number;
  /** Seconds of earlier Conversation Screening sees. */
  contextWindow?: number;
  /** Minimum Conversation seconds between Interjections. */
  minInterjectionGap?: number;
  /** Called as soon as each event is known, for progress output. Not in time order. */
  onEvent?: (event: ReplayEvent) => void;
};

/**
 * Replays a Transcript as if live (ADR 0001): Screening runs as each Utterance
 * ends and only sees the Transcript so far; each Verdict is stamped with when it
 * would have arrived, from measured stage durations.
 */
export async function replay(transcript: Transcript, deps: ReplayDeps): Promise<ReplayEvent[]> {
  const {
    screen,
    verify,
    checkCorrected,
    clock = () => performance.now() / 1000,
    transcriptionDelay = 2,
    contextWindow = 120,
    minInterjectionGap = 120,
  } = deps;
  const events: ReplayEvent[] = [];
  const emit = (event: ReplayEvent) => {
    events.push(event);
    deps.onEvent?.(event);
  };

  async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
    const started = clock();
    const result = await work();
    return [result, clock() - started];
  }

  const claims: Claim[] = [];
  const pending: Promise<{ claim: Claim; at: number; verdict: Verdict } | undefined>[] = [];
  // Screening handles one Utterance at a time, so a slow Screening delays the next.
  let screenerFreeAt = 0;

  const { utterances } = transcript;
  for (const [i, utterance] of utterances.entries()) {
    const heardAt = utterance.end + transcriptionDelay;
    emit({ type: "utterance", at: heardAt, utterance });

    const context = utterances
      .slice(0, i + 1)
      .filter((u) => u.end >= utterance.end - contextWindow);
    const startedAt = Math.max(heardAt, screenerFreeAt);
    let screened;
    try {
      screened = await timed(() =>
        screen({ context, utterance, knownClaims: claims.map(({ id, text }) => ({ id, text })) }),
      );
    } catch (error) {
      emit({ type: "error", at: startedAt, stage: "screening", subject: utterance.id, message: String(error) });
      continue;
    }
    const [result, screeningSeconds] = screened;
    const screenedAt = startedAt + screeningSeconds;
    screenerFreeAt = screenedAt;

    for (const repeat of result.repeats) {
      emit({ type: "repeat", at: screenedAt, claimId: repeat.claimId, utteranceId: utterance.id, quote: repeat.quote });
    }
    for (const found of result.claims) {
      const claim: Claim = {
        id: `c${claims.length + 1}`,
        text: found.text,
        quote: found.quote,
        speaker: utterance.speaker,
        utteranceIds: [utterance.id],
      };
      claims.push(claim);
      emit({ type: "claim", at: screenedAt, claim, screeningSeconds });

      // Verifications run concurrently with later Screening, as they would live.
      pending.push(
        timed(() => verify(claim)).then(
          ([verdict, verificationSeconds]) => {
            const at = screenedAt + verificationSeconds;
            emit({ type: "verification", at, claimId: claim.id, verdict, verificationSeconds });
            return { claim, at, verdict };
          },
          (error) => {
            emit({ type: "error", at: screenedAt, stage: "verification", subject: claim.id, message: String(error) });
            return undefined;
          },
        ),
      );
    }
  }

  const verified = (await Promise.all(pending)).filter((v) => v !== undefined);

  // Only Verdicts worth interjecting on pay for a check that nobody already corrected the Claim,
  // using only what was said before the Verdict arrived.
  const candidates = await Promise.all(
    verified.map(async ({ claim, at, verdict }) => {
      if (!worthInterjecting(verdict).interject) return { claimId: claim.id, at, verdict, alreadyCorrected: false };
      const claimEnd = utterances.find((u) => u.id === claim.utteranceIds.at(-1))!.end;
      const later = utterances.filter((u) => u.start >= claimEnd && u.end + transcriptionDelay <= at);
      const [alreadyCorrected, seconds] = await timed(() => checkCorrected(claim, verdict, later));
      return { claimId: claim.id, at: at + seconds, verdict, alreadyCorrected };
    }),
  );

  const decisions = decideInterjections(candidates, { minGap: minInterjectionGap });
  for (const c of candidates) {
    const decision = decisions.get(c.claimId)!;
    emit({ type: "decision", at: c.at, claimId: c.claimId, decision });
    if (decision.interject) {
      const claim = claims.find((cl) => cl.id === c.claimId)!;
      emit({ type: "interjection", at: c.at, claimId: c.claimId, text: formatInterjection(claim, c.verdict) });
    }
  }

  return events.sort((a, b) => a.at - b.at);
}
