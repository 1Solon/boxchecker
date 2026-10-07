import type { SpeakerId, Transcript, Utterance } from "./domain.ts";

/** A timed piece of transcribed speech, as returned by a transcriber for one Speaker's audio. */
export type Segment = { start: number; end: number; text: string };

export type SpeakerSegments = { speaker: SpeakerId; segments: Segment[] };

export type BuildOptions = {
  /** Longest silence (s) within one Utterance. */
  maxGap?: number;
  /** Longest an Utterance may grow (s) before a new one starts. */
  maxDuration?: number;
};

// Whisper emits these for silence and background noise.
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\))\s*$/;

/** Turns each Speaker's segments into one time-ordered Transcript of Utterances. */
export function buildTranscript(
  tracks: SpeakerSegments[],
  { maxGap = 1.0, maxDuration = 30 }: BuildOptions = {},
): Transcript {
  const timeline = tracks
    .flatMap(({ speaker, segments }) =>
      segments.map((s) => ({ speaker, start: s.start, end: s.end, text: s.text.trim() })),
    )
    .filter((s) => s.text !== "" && !NON_SPEECH.test(s.text))
    .sort((a, b) => a.start - b.start);

  const utterances: Utterance[] = [];
  for (const s of timeline) {
    const last = utterances.at(-1);
    if (
      last &&
      last.speaker === s.speaker &&
      s.start - last.end <= maxGap &&
      s.end - last.start <= maxDuration
    ) {
      last.end = s.end;
      last.text = `${last.text} ${s.text}`;
    } else {
      utterances.push({ id: `u${utterances.length + 1}`, ...s });
    }
  }

  return { speakers: tracks.map((t) => t.speaker), utterances };
}

/** Splits a Conversation recording into one track per Speaker and transcribes each. */
export async function transcribeConversation(
  audioFile: string,
  deps: {
    transcriber: { transcribe(wavFile: string): Promise<Segment[]> };
    countChannels(file: string): Promise<number>;
    extractChannel(file: string, channel: number | "mix", out: string): Promise<void>;
    workDir: string;
  },
): Promise<Transcript> {
  const channels = await deps.countChannels(audioFile);
  if (channels > 2) {
    throw new Error(`${audioFile} has ${channels} channels; BoxChecker supports mono or one Speaker per stereo channel`);
  }
  const tracks: { speaker: SpeakerId; channel: number | "mix" }[] =
    channels === 2
      ? [{ speaker: "A", channel: 0 }, { speaker: "B", channel: 1 }]
      : [{ speaker: "Unknown", channel: "mix" }];

  const transcribed: SpeakerSegments[] = [];
  for (const { speaker, channel } of tracks) {
    const wav = `${deps.workDir}/track-${speaker}.wav`;
    await deps.extractChannel(audioFile, channel, wav);
    transcribed.push({ speaker, segments: await deps.transcriber.transcribe(wav) });
  }
  return buildTranscript(transcribed);
}
