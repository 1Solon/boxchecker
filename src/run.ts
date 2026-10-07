import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { audioDuration, countChannels, extractChannel } from "./audio.ts";
import type { Config } from "./config.ts";
import type { Transcript } from "./domain.ts";
import { modelCorrectionCheck } from "./interjection.ts";
import { openAiCompatibleModel } from "./llm.ts";
import { replay, type ReplayEvent } from "./replay.ts";
import { renderReport } from "./report.ts";
import { modelScreener } from "./screening.ts";
import { firecrawlSearch } from "./search.ts";
import { formatTime } from "./time.ts";
import { transcribeConversation } from "./transcript.ts";
import { openAiCompatibleTranscriber } from "./transcription.ts";
import { pipelineVerifier } from "./verification.ts";

export type Stage = "transcribing" | "replaying";

/** How far through the current Stage a run is; `fraction` is null when there is no way to tell. */
export type Progress = { fraction: number | null; detail: string };

export type RunOptions = {
  title: string;
  transcriptionDelay?: number;
  /** Treat stereo as an ordinary mix rather than one Speaker per channel. */
  mixChannels?: boolean;
  onStage?: (stage: Stage, detail: string) => void;
  onEvent?: (event: ReplayEvent) => void;
  onProgress?: (progress: Progress) => void;
};

export async function transcribeFile(
  audio: string,
  config: Config,
  workDir: string,
  { mixChannels, onProgress }: Pick<RunOptions, "mixChannels" | "onProgress"> = {},
): Promise<Transcript> {
  return transcribeConversation(audio, {
    transcriber: openAiCompatibleTranscriber(config.transcription),
    countChannels,
    duration: audioDuration,
    extractChannel,
    workDir,
    mixChannels,
    onProgress: (done, total) =>
      onProgress?.({ fraction: total ? done / total : null, detail: `Transcribed ${formatTime(done)} of ${formatTime(total)}` }),
  });
}

/**
 * Turns replay events into progress across both Screening every Utterance and Verifying every
 * Claim, projecting how many Claims the rest of the Transcript will turn up so the bar (and the
 * browser's ETA) moves steadily instead of restarting between the two.
 */
export function replayProgress(utterances: number, onProgress: (progress: Progress) => void) {
  let heard = 0;
  let claims = 0;
  let verified = 0;
  let highest = 0;
  return (event: ReplayEvent) => {
    if (event.type === "utterance") heard++;
    else if (event.type === "claim") claims++;
    else if (event.type === "verification" || (event.type === "error" && event.stage === "verification")) verified++;
    else return;
    const found = `${claims} Claim${claims === 1 ? "" : "s"} found, ${verified} verified`;
    if (heard >= utterances && verified >= claims) return onProgress({ fraction: null, detail: `Deciding Interjections · ${found}` });

    const expectedClaims = heard >= utterances || heard === 0 ? claims : Math.max(claims, (claims * utterances) / heard);
    const work = utterances + expectedClaims;
    highest = Math.max(highest, work ? (heard + verified) / work : 0);
    onProgress({
      fraction: Math.min(highest, 0.99),
      detail: heard < utterances ? `Screening Utterance ${heard} of ${utterances} · ${found}` : `Verifying Claims · ${found}`,
    });
  };
}

/**
 * Transcribes (unless given a transcript .json) and replays a recording, writing
 * transcript.json, events.jsonl and report.md into `runDir`.
 */
export async function runReplay(
  input: string,
  runDir: string,
  config: Config,
  { title, transcriptionDelay = 2, mixChannels, onStage, onEvent, onProgress }: RunOptions,
): Promise<ReplayEvent[]> {
  let transcript: Transcript;
  if (extname(input) === ".json") {
    transcript = JSON.parse(await readFile(input, "utf8"));
  } else {
    onStage?.("transcribing", `Transcribing ${input}…`);
    transcript = await transcribeFile(input, config, runDir, { mixChannels, onProgress });
  }
  await writeFile(join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));

  onStage?.("replaying", `Replaying ${transcript.utterances.length} Utterances…`);
  const progress = onProgress && replayProgress(transcript.utterances.length, onProgress);
  const screeningModel = openAiCompatibleModel(config.screening);
  const verificationModel = openAiCompatibleModel(config.verification);
  const events = await replay(transcript, {
    screen: modelScreener(screeningModel),
    verify: pipelineVerifier(verificationModel, firecrawlSearch(config.firecrawlUrl)),
    checkCorrected: modelCorrectionCheck(screeningModel),
    transcriptionDelay,
    onEvent: (event) => {
      onEvent?.(event);
      progress?.(event);
    },
  });

  await writeFile(join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(runDir, "report.md"), renderReport(events, { title, transcriptionDelay }));
  return events;
}

export async function readEvents(runDir: string): Promise<ReplayEvent[]> {
  return (await readFile(join(runDir, "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
