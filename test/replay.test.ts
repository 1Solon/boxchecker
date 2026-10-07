import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Utterance, Verdict } from "../src/domain.ts";
import type { CorrectionCheck } from "../src/interjection.ts";
import { replay, type ReplayDeps, type ReplayEvent } from "../src/replay.ts";
import type { ScreeningInput, ScreeningResult } from "../src/screening.ts";

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const u = (id: string, start: number, end: number, text: string, speaker = "A"): Utterance => ({
  id,
  speaker,
  start,
  end,
  text,
});

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  label: "refuted",
  confidence: "high",
  explanation: "It was 3-0.",
  important: true,
  sources: [{ url: "https://example.com", title: "Example" }],
  readPages: false,
  ...overrides,
});

/** Screener that finds a Claim wherever an Utterance mentions "claim:". */
function screenerFinding(seconds = 1, repeats: Record<string, string> = {}) {
  const calls: ScreeningInput[] = [];
  const screen = async (input: ScreeningInput): Promise<ScreeningResult> => {
    calls.push(input);
    await sleep(seconds);
    const match = input.utterance.text.match(/claim: (.*)/);
    if (!match) return { claims: [], repeats: [] };
    const repeatOf = repeats[input.utterance.id];
    return repeatOf
      ? { claims: [], repeats: [{ claimId: repeatOf, quote: match[1]! }] }
      : { claims: [{ text: match[1]!, quote: match[1]! }], repeats: [] };
  };
  return { screen, calls };
}

async function run(utterances: Utterance[], deps: Partial<ReplayDeps>) {
  const result = replay(
    { speakers: ["A", "B"], utterances },
    {
      screen: screenerFinding().screen,
      verify: async () => {
        await sleep(10);
        return verdict();
      },
      checkCorrected: async () => false,
      clock: () => Date.now() / 1000,
      transcriptionDelay: 2,
      ...deps,
    },
  );
  await vi.runAllTimersAsync();
  return result;
}

const ofType = <T extends ReplayEvent["type"]>(events: ReplayEvent[], type: T) =>
  events.filter((e): e is Extract<ReplayEvent, { type: T }> => e.type === type);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("replay", () => {
  it("only lets Screening see the Transcript up to the Utterance that just ended, within the context window", async () => {
    const { screen, calls } = screenerFinding();
    await run(
      [u("u1", 0, 5, "old"), u("u2", 100, 110, "recent"), u("u3", 200, 205, "now"), u("u4", 300, 305, "future")],
      { screen, contextWindow: 120 },
    );

    const third = calls.find((c) => c.utterance.id === "u3")!;
    expect(third.context.map((c) => c.id)).toEqual(["u2", "u3"]);
  });

  it("stamps Claims and Verdicts with when they would have arrived live", async () => {
    const events = await run([u("u1", 0, 10, "claim: France beat Brazil 2-0 in 1998")], {
      screen: screenerFinding(1.5).screen,
    });

    // speech ends at 10, +2 transcription, +1.5 Screening, +10 Verification
    expect(ofType(events, "claim")[0]).toMatchObject({ at: 13.5, screeningSeconds: 1.5 });
    expect(ofType(events, "verification")[0]).toMatchObject({ at: 23.5, verificationSeconds: 10 });
  });

  it("queues Screening behind a slow previous Screening", async () => {
    const events = await run([u("u1", 0, 1, "hi"), u("u2", 1.5, 2, "claim: something")], {
      screen: screenerFinding(5).screen,
    });

    // u1 Screening runs 3 → 8; u2 is heard at 4 but waits until 8, finishing at 13.
    expect(ofType(events, "claim")[0]!.at).toBe(13);
  });

  it("does not hold up Screening while Verifications run", async () => {
    const events = await run(
      [u("u1", 0, 1, "claim: one"), u("u2", 2, 3, "claim: two")],
      { verify: async () => (await sleep(30), verdict({ label: "supported" })) },
    );

    expect(ofType(events, "claim").map((e) => e.at)).toEqual([4, 6]);
    expect(ofType(events, "verification").map((e) => e.at)).toEqual([34, 36]);
  });

  it("records a repeated Claim without verifying it again", async () => {
    const verify = vi.fn(async () => verdict({ label: "supported" }));
    const { screen, calls } = screenerFinding(1, { u2: "c1" });
    const events = await run([u("u1", 0, 1, "claim: one"), u("u2", 5, 6, "claim: one again")], { verify, screen });

    expect(calls[1]!.knownClaims).toEqual([{ id: "c1", text: "one" }]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(ofType(events, "repeat")).toEqual([
      { type: "repeat", at: 9, claimId: "c1", utteranceId: "u2", quote: "one again" },
    ]);
  });

  it("interjects on a confident, important refutation", async () => {
    const events = await run([u("u1", 0, 10, "claim: France beat Brazil 2-0 in 1998")], {});

    expect(ofType(events, "interjection")).toEqual([
      {
        type: "interjection",
        at: 23,
        claimId: "c1",
        text: '🔍 **Refuted**: _"France beat Brazil 2-0 in 1998"_ It was 3-0. [Example](https://example.com)',
      },
    ]);
  });

  it("checks for an earlier correction using only what was said before the Verdict arrived", async () => {
    const checkCorrected = vi.fn<CorrectionCheck>(async () => true);
    const events = await run(
      [
        u("u1", 0, 10, "claim: France beat Brazil 2-0 in 1998"),
        u("u2", 11, 12, "No, it was 3-0", "B"),
        u("u3", 30, 31, "too late", "B"),
      ],
      { checkCorrected },
    );

    // Verdict arrives at 10 + 2 + 1 + 10 = 23; u3 is heard at 33.
    expect(checkCorrected.mock.calls[0]![2].map((x) => x.id)).toEqual(["u2"]);
    expect(ofType(events, "decision")[0]!.decision).toEqual({ interject: false, reason: "already-corrected" });
    expect(ofType(events, "interjection")).toEqual([]);
  });

  it("keeps going when a Verification fails", async () => {
    let calls = 0;
    const events = await run([u("u1", 0, 1, "claim: one"), u("u2", 5, 6, "claim: two")], {
      verify: async () => {
        if (calls++ === 0) throw new Error("search down");
        return verdict({ label: "supported" });
      },
    });

    expect(ofType(events, "error")).toMatchObject([{ stage: "verification", subject: "c1" }]);
    expect(ofType(events, "verification").map((e) => e.claimId)).toEqual(["c2"]);
  });
});
