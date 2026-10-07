import { describe, expect, it } from "vitest";
import type { Verdict } from "../src/domain.ts";
import { decideInterjections, formatInterjection } from "../src/interjection.ts";

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  label: "refuted",
  confidence: "high",
  explanation: "It was 3-0.",
  important: true,
  sources: [],
  readPages: false,
  ...overrides,
});

const decide = (...candidates: [string, number, Verdict, boolean?][]) =>
  Object.fromEntries(
    decideInterjections(
      candidates.map(([claimId, at, v, alreadyCorrected = false]) => ({ claimId, at, verdict: v, alreadyCorrected })),
    ),
  );

describe("decideInterjections", () => {
  it("interjects only on confident, important Refuted or Misleading Verdicts", () => {
    expect(
      decide(
        ["refuted", 0, verdict()],
        ["misleading", 200, verdict({ label: "misleading" })],
        ["supported", 400, verdict({ label: "supported" })],
        ["unverifiable", 600, verdict({ label: "unverifiable" })],
        ["unsure", 800, verdict({ confidence: "medium" })],
        ["trivial", 1000, verdict({ important: false })],
        ["corrected", 1200, verdict(), true],
      ),
    ).toEqual({
      refuted: { interject: true },
      misleading: { interject: true },
      supported: { interject: false, reason: "verdict" },
      unverifiable: { interject: false, reason: "verdict" },
      unsure: { interject: false, reason: "confidence" },
      trivial: { interject: false, reason: "unimportant" },
      corrected: { interject: false, reason: "already-corrected" },
    });
  });

  it("allows at most one Interjection per gap, in the order Verdicts arrive", () => {
    expect(decide(["late", 150, verdict()], ["first", 10, verdict()], ["soon", 100, verdict()])).toEqual({
      first: { interject: true },
      soon: { interject: false, reason: "rate-limited" },
      late: { interject: true },
    });
  });

  it("does not let a skipped Verdict start the rate limit", () => {
    expect(decide(["skipped", 0, verdict({ label: "supported" })], ["next", 10, verdict()])).toEqual({
      skipped: { interject: false, reason: "verdict" },
      next: { interject: true },
    });
  });
});

describe("formatInterjection", () => {
  it("puts the Verdict first and links at most two Sources", () => {
    const text = formatInterjection(
      { text: "80% of startups fail in their first year." },
      verdict({
        label: "misleading",
        explanation: "About 20% fail in year one.",
        sources: [
          { url: "https://bls.gov", title: "BLS" },
          { url: "https://b.example", title: "B" },
          { url: "https://c.example", title: "C" },
        ],
      }),
    );

    expect(text).toBe(
      '🔍 **Misleading**: _"80% of startups fail in their first year."_ About 20% fail in year one. [BLS](https://bls.gov) · [B](https://b.example)',
    );
  });
});
