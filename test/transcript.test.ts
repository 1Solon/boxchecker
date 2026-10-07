import { describe, expect, it } from "vitest";
import { buildTranscript } from "../src/transcript.ts";

const seg = (start: number, end: number, text: string) => ({ start, end, text });

describe("buildTranscript", () => {
  it("interleaves Speakers in time order", () => {
    const transcript = buildTranscript([
      { speaker: "A", segments: [seg(0, 2, "Hi."), seg(10, 12, "Right.")] },
      { speaker: "B", segments: [seg(4, 8, "Hello there.")] },
    ]);

    expect(transcript.speakers).toEqual(["A", "B"]);
    expect(transcript.utterances.map((u) => [u.id, u.speaker, u.text])).toEqual([
      ["u1", "A", "Hi."],
      ["u2", "B", "Hello there."],
      ["u3", "A", "Right."],
    ]);
  });

  it("merges a Speaker's consecutive segments separated by a short pause", () => {
    const transcript = buildTranscript([
      { speaker: "A", segments: [seg(0, 2, "France won"), seg(2.5, 4, "in 1998.")] },
    ]);

    expect(transcript.utterances).toEqual([
      { id: "u1", speaker: "A", start: 0, end: 4, text: "France won in 1998." },
    ]);
  });

  it("splits on a long pause", () => {
    const transcript = buildTranscript([
      { speaker: "A", segments: [seg(0, 2, "One."), seg(5, 6, "Two.")] },
    ]);

    expect(transcript.utterances.map((u) => u.text)).toEqual(["One.", "Two."]);
  });

  it("does not merge across another Speaker's interruption", () => {
    const transcript = buildTranscript([
      { speaker: "A", segments: [seg(0, 2, "It was 1969"), seg(2.4, 4, "for sure.")] },
      { speaker: "B", segments: [seg(2.1, 2.3, "No.")] },
    ]);

    expect(transcript.utterances.map((u) => `${u.speaker}:${u.text}`)).toEqual([
      "A:It was 1969",
      "B:No.",
      "A:for sure.",
    ]);
  });

  it("caps how long one Utterance can grow, so a monologue still yields regular Utterances", () => {
    const segments = Array.from({ length: 10 }, (_, i) => seg(i * 5, i * 5 + 5, `s${i}.`));
    const transcript = buildTranscript([{ speaker: "A", segments }], { maxDuration: 20 });

    expect(transcript.utterances.map((u) => [u.start, u.end])).toEqual([
      [0, 20],
      [20, 40],
      [40, 50],
    ]);
  });

  it("drops blank segments and Whisper's non-speech annotations", () => {
    const transcript = buildTranscript([
      {
        speaker: "A",
        segments: [seg(0, 1, " [BLANK_AUDIO]"), seg(1, 2, "(music)"), seg(2, 3, "  "), seg(3, 4, " Hi. ")],
      },
    ]);

    expect(transcript.utterances.map((u) => u.text)).toEqual(["Hi."]);
  });
});
