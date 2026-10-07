import { describe, expect, it } from "vitest";
import type { Claim, Verdict } from "../src/domain.ts";
import type { ReplayEvent } from "../src/replay.ts";
import { AnswerKey, score, type Matcher } from "../src/scoring.ts";

const verdict = (label: Verdict["label"]): Verdict => ({
  label,
  confidence: "high",
  explanation: "",
  important: true,
  sources: [],
  readPages: false,
});

function claimAt(id: string, end: number, text: string, label: Verdict["label"], verifiedAt: number): ReplayEvent[] {
  const claim: Claim = { id, text, quote: text, speaker: "A", utteranceIds: [`u-${id}`] };
  return [
    { type: "utterance", at: end + 2, utterance: { id: `u-${id}`, speaker: "A", start: end - 3, end, text } },
    { type: "claim", at: end + 3, claim, screeningSeconds: 1 },
    { type: "verification", at: verifiedAt, claimId: id, verdict: verdict(label), verificationSeconds: verifiedAt - end - 3 },
  ];
}

/** Matches when the candidate text contains the planted claim's first word. */
const firstWordMatcher: Matcher = async (planted, candidates) =>
  candidates.find((c) => c.text.startsWith(planted.claim.split(" ")[0]!))?.id ?? null;

describe("AnswerKey", () => {
  it("accepts times as m:ss", () => {
    const key = AnswerKey.parse({ claims: [{ at: "1:05", claim: "x", verdict: "refuted", interject: true }] });
    expect(key.claims[0]!.at).toBe(65);
  });
});

describe("score", () => {
  it("matches Planted Claims within the time window and scores Verdicts, Interjections, and delay", async () => {
    const events: ReplayEvent[] = [
      ...claimAt("c1", 60, "France beat Brazil 2-0", "refuted", 80),
      { type: "interjection", at: 80, claimId: "c1", text: "…" },
      ...claimAt("c2", 120, "Apollo 11 landed in 1969", "refuted", 160),
      ...claimAt("c3", 200, "Rust 1.0 shipped in 2015", "supported", 210),
      // Same wording as a Planted Claim, but far outside its window.
      ...claimAt("c4", 500, "Eiffel Tower is 330m", "supported", 510),
    ];
    const key = AnswerKey.parse({
      claims: [
        { at: "1:05", claim: "France beat Brazil 2-0 in 1998", verdict: "refuted", interject: true },
        { at: "2:00", claim: "Apollo 11 landed in 1969", verdict: "supported", interject: false },
        { at: "4:00", claim: "Eiffel Tower is 330m tall", verdict: "supported", interject: false },
      ],
    });

    const s = await score(events, key, firstWordMatcher);

    expect(s.results.map((r) => [r.claimId, r.verdict, r.interjected, r.delay])).toEqual([
      ["c1", "refuted", true, 20],
      ["c2", "refuted", false, 40],
      [null, null, false, null],
    ]);
    expect(s).toMatchObject({ caught: 2, verdictsRight: 1, interjectionsRight: 3, maxDelay: 40 });
    expect(s.unplanted.map((c) => c.id)).toEqual(["c3", "c4"]);
  });

  it("matches each found Claim to at most one Planted Claim", async () => {
    const events = claimAt("c1", 60, "France beat Brazil", "refuted", 70);
    const key = AnswerKey.parse({
      claims: [
        { at: 60, claim: "France beat Brazil 2-0", verdict: "refuted", interject: true },
        { at: 61, claim: "France beat Brazil in 1998", verdict: "supported", interject: false },
      ],
    });

    const s = await score(events, key, firstWordMatcher);

    expect(s.results.map((r) => r.claimId)).toEqual(["c1", null]);
  });
});
