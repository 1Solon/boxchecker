import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { countChannels, extractChannel } from "./audio.ts";
import type { Config } from "./config.ts";
import type { Transcript } from "./domain.ts";
import { modelCorrectionCheck } from "./interjection.ts";
import { openAiCompatibleModel } from "./llm.ts";
import { replay, type ReplayEvent } from "./replay.ts";
import { renderReport } from "./report.ts";
import { modelScreener } from "./screening.ts";
import { firecrawlSearch } from "./search.ts";
import { transcribeConversation } from "./transcript.ts";
import { openAiCompatibleTranscriber } from "./transcription.ts";
import { pipelineVerifier } from "./verification.ts";

export type Stage = "transcribing" | "replaying";

export type RunOptions = {
  title: string;
  transcriptionDelay?: number;
  onStage?: (stage: Stage, detail: string) => void;
  onEvent?: (event: ReplayEvent) => void;
};

export async function transcribeFile(audio: string, config: Config, workDir: string): Promise<Transcript> {
  return transcribeConversation(audio, {
    transcriber: openAiCompatibleTranscriber(config.transcription),
    countChannels,
    extractChannel,
    workDir,
  });
}

/**
 * Transcribes (unless given a transcript .json) and replays a recording, writing
 * transcript.json, events.jsonl and report.md into `runDir`.
 */
export async function runReplay(
  input: string,
  runDir: string,
  config: Config,
  { title, transcriptionDelay = 2, onStage, onEvent }: RunOptions,
): Promise<ReplayEvent[]> {
  let transcript: Transcript;
  if (extname(input) === ".json") {
    transcript = JSON.parse(await readFile(input, "utf8"));
  } else {
    onStage?.("transcribing", `Transcribing ${input}…`);
    transcript = await transcribeFile(input, config, runDir);
  }
  await writeFile(join(runDir, "transcript.json"), JSON.stringify(transcript, null, 2));

  onStage?.("replaying", `Replaying ${transcript.utterances.length} Utterances…`);
  const screeningModel = openAiCompatibleModel(config.screening);
  const verificationModel = openAiCompatibleModel(config.verification);
  const events = await replay(transcript, {
    screen: modelScreener(screeningModel),
    verify: pipelineVerifier(verificationModel, firecrawlSearch(config.firecrawlUrl)),
    checkCorrected: modelCorrectionCheck(screeningModel),
    transcriptionDelay,
    onEvent,
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
