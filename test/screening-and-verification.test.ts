import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { JsonModel } from "../src/llm.ts";
import { modelScreener } from "../src/screening.ts";
import { excerpt, type Search } from "../src/search.ts";
import { pipelineVerifier } from "../src/verification.ts";

/** A model that answers each call with the next canned response. */
function scriptedModel(...responses: unknown[]) {
  const prompts: { system: string; user: string }[] = [];
  const model: JsonModel = {
    async json<T>({ system, user, schema }: { system: string; user: string; schema: z.ZodType<T> }) {
      prompts.push({ system, user });
      return schema.parse(responses.shift());
    },
  };
  return { model, prompts };
}

const utterance = { id: "u2", speaker: "A", start: 10, end: 12, text: "he won it in 98" };

describe("modelScreener", () => {
  it("separates new Claims from repeats of known Claims", async () => {
    const { model } = scriptedModel({
      claims: [
        { quote: "won it in 98", claim: "France won the 1998 FIFA World Cup.", repeat_of: null },
        { quote: "like I said", claim: "Apollo 11 landed in 1969.", repeat_of: "c1" },
        { quote: "made up", claim: "Something new.", repeat_of: "c99" },
      ],
    });

    const result = await modelScreener(model)({
      context: [utterance],
      utterance,
      knownClaims: [{ id: "c1", text: "Apollo 11 landed on the Moon in 1969." }],
    });

    expect(result).toEqual({
      claims: [
        { text: "France won the 1998 FIFA World Cup.", quote: "won it in 98" },
        { text: "Something new.", quote: "made up" },
      ],
      repeats: [{ claimId: "c1", quote: "like I said" }],
    });
  });

  it("marks which Utterance is new", async () => {
    const { model, prompts } = scriptedModel({ claims: [] });
    const earlier = { id: "u1", speaker: "B", start: 0, end: 5, text: "Who won in 1998?" };

    await modelScreener(model)({ context: [earlier, utterance], utterance, knownClaims: [] });

    expect(prompts[0]!.user).toContain("[0:00] B: Who won in 1998?\n[0:10] A (LAST): he won it in 98");
  });
});

describe("pipelineVerifier", () => {
  const judgement = (verdict: string, confidence: string, sources = [1]) => ({
    verdict,
    confidence,
    explanation: "France beat Brazil 3-0.",
    important: true,
    sources,
  });

  function recordingSearch(): { search: Search; calls: { query: string; readPages: boolean }[] } {
    const calls: { query: string; readPages: boolean }[] = [];
    return {
      calls,
      search: async (query, { readPages }) => {
        calls.push({ query, readPages });
        return [
          {
            url: `https://example.com/${encodeURIComponent(query)}`,
            title: query,
            snippet: "France won 3-0.",
            ...(readPages ? { content: "France won the final 3–0 against Brazil." } : {}),
          },
        ];
      },
    };
  }

  it("stops at snippets when they settle the Claim", async () => {
    const { search, calls } = recordingSearch();
    const { model } = scriptedModel({ queries: ["1998 world cup final score"] }, judgement("refuted", "high"));

    const verdict = await pipelineVerifier(model, search)({ text: "France beat Brazil 2-0 in the 1998 final." });

    expect(calls).toEqual([{ query: "1998 world cup final score", readPages: false }]);
    expect(verdict).toMatchObject({
      label: "refuted",
      readPages: false,
      sources: [{ url: "https://example.com/1998%20world%20cup%20final%20score", title: "1998 world cup final score" }],
    });
  });

  it("reads full pages when snippets leave it Unverifiable or low-confidence", async () => {
    const { search, calls } = recordingSearch();
    const { model, prompts } = scriptedModel(
      { queries: ["q1", "q2"] },
      judgement("unverifiable", "low"),
      judgement("refuted", "high"),
    );

    const verdict = await pipelineVerifier(model, search)({ text: "France beat Brazil 2-0 in the 1998 final." });

    expect(calls.at(-1)).toEqual({ query: "q1", readPages: true });
    expect(prompts.at(-1)!.user).toContain("France won the final 3–0 against Brazil.");
    expect(verdict).toMatchObject({ label: "refuted", readPages: true });
  });

  it("ignores Sources the model invents", async () => {
    const { search } = recordingSearch();
    const { model } = scriptedModel({ queries: ["q"] }, judgement("refuted", "high", [7, 1]));

    const verdict = await pipelineVerifier(model, search)({ text: "x" });

    expect(verdict.sources.map((s) => s.title)).toEqual(["q"]);
  });
});

describe("excerpt", () => {
  it("keeps the paragraphs that mention the Claim, in page order, within the budget", () => {
    const page = [
      "Navigation menu",
      "The 1998 FIFA World Cup final was played in Saint-Denis.",
      "Unrelated history of football boots.",
      "France beat Brazil 3–0 in the final, with Zidane scoring twice.",
    ].join("\n\n");

    expect(excerpt(page, "France beat Brazil 2-0 in the 1998 World Cup final")).toBe(
      "The 1998 FIFA World Cup final was played in Saint-Denis.\n\nFrance beat Brazil 3–0 in the final, with Zidane scoring twice.",
    );
    expect(excerpt(page, "France beat Brazil in the 1998 final", 70)).toBe(
      "France beat Brazil 3–0 in the final, with Zidane scoring twice.",
    );
  });
});
