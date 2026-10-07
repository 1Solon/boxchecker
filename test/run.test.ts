import { describe, expect, it } from "vitest";
import type { ReplayEvent } from "../src/replay.ts";
import { replayProgress, type Progress } from "../src/run.ts";

const utterance = (n: number): ReplayEvent => ({
  type: "utterance",
  at: n,
  utterance: { id: `u${n}`, speaker: "Unknown", start: n, end: n + 1, text: "…" },
});
const claim = (n: number): ReplayEvent => ({
  type: "claim",
  at: n,
  claim: { id: `c${n}`, text: "…", quote: "…", speaker: "Unknown", utteranceIds: ["u1"] },
  screeningSeconds: 1,
});
const verdict = (n: number): ReplayEvent => ({
  type: "verification",
  at: n,
  claimId: `c${n}`,
  verdict: { label: "supported", confidence: "high", explanation: "…", important: false, sources: [], readPages: false },
  verificationSeconds: 1,
});

describe("replayProgress", () => {
  it("moves steadily through Screening and Verification, then waits on Interjection decisions", () => {
    const seen: Progress[] = [];
    const track = replayProgress(4, (p) => seen.push(p));
    for (const event of [utterance(1), claim(1), utterance(2), verdict(1), utterance(3), claim(2), utterance(4), claim(3), verdict(2), verdict(3)]) {
      track(event);
    }

    const fractions = seen.map((p) => p.fraction).filter((f) => f !== null);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.every((f) => f > 0 && f < 1)).toBe(true);
    expect(seen[0]!.detail).toBe("Screening Utterance 1 of 4 · 0 Claims found, 0 verified");
    expect(seen.at(-2)!.detail).toBe("Verifying Claims · 3 Claims found, 2 verified");
    expect(seen.at(-1)).toEqual({ fraction: null, detail: "Deciding Interjections · 3 Claims found, 3 verified" });
  });
});
