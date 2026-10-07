import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { loadConfig, type Config } from "./config.ts";
import { openAiCompatibleModel } from "./llm.ts";
import type { ReplayEvent } from "./replay.ts";
import { readEvents, runReplay, transcribeFile } from "./run.ts";
import { AnswerKey, modelMatcher, renderScore, score } from "./scoring.ts";
import { serve } from "./server.ts";
import { formatTime } from "./time.ts";

const USAGE = `Usage:
  boxchecker transcribe <audio> [--out transcript.json]
  boxchecker replay <audio | transcript.json> [--key answers.yaml] [--out runs/<name>] [--transcription-delay 2]
  boxchecker score <run-dir> <answers.yaml>
  boxchecker serve [--host 0.0.0.0] [--port 8790]`;

async function transcribe(args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { out: { type: "string" } } });
  const [audio] = positionals;
  if (!audio) throw new Error(USAGE);

  const workDir = join("runs", `${basename(audio, extname(audio))}-transcribe`);
  await mkdir(workDir, { recursive: true });
  const json = JSON.stringify(await transcribeFile(audio, loadConfig(), workDir), null, 2);
  if (values.out) await writeFile(values.out, json);
  else console.log(json);
}

function describe(event: ReplayEvent): string | undefined {
  const at = `[${formatTime(event.at)}]`;
  switch (event.type) {
    case "claim":
      return `${at} claim ${event.claim.id}: ${event.claim.text}`;
    case "repeat":
      return `${at} repeat of ${event.claimId}`;
    case "verification":
      return `${at} ${event.claimId} ${event.verdict.label} (${event.verdict.confidence}): ${event.verdict.explanation}`;
    case "interjection":
      return `${at} INTERJECTION ${event.text}`;
    case "error":
      return `${at} ${event.stage} error on ${event.subject}: ${event.message}`;
  }
}

async function replayCommand(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      key: { type: "string" },
      "transcription-delay": { type: "string", default: "2" },
    },
  });
  const [input] = positionals;
  if (!input) throw new Error(USAGE);
  const transcriptionDelay = Number(values["transcription-delay"]);

  const config = loadConfig();
  const name = basename(input, extname(input)).replace(/\.transcript$/, "");
  const runDir = values.out ?? join("runs", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(runDir, { recursive: true });

  await runReplay(input, runDir, config, {
    title: `BoxChecker replay: ${name}`,
    transcriptionDelay,
    onStage: (_stage, detail) => console.error(detail),
    onEvent: (event) => {
      const line = describe(event);
      if (line) console.error(line);
    },
  });

  console.error(`Wrote ${runDir}/report.md`);
  if (values.key) await scoreRun(runDir, values.key, config);
}

async function scoreRun(runDir: string, keyFile: string, config: Config) {
  const events = await readEvents(runDir);
  const key = AnswerKey.parse(parseYaml(await readFile(keyFile, "utf8")));
  const result = await score(events, key, modelMatcher(openAiCompatibleModel(config.screening)));
  const markdown = renderScore(result);
  await writeFile(join(runDir, "score.md"), markdown);
  console.log(markdown);
}

async function scoreCommand(args: string[]) {
  const [runDir, keyFile] = args;
  if (!runDir || !keyFile) throw new Error(USAGE);
  await scoreRun(runDir, keyFile, loadConfig());
}

async function serveCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { host: { type: "string", default: "0.0.0.0" }, port: { type: "string", default: "8790" } },
  });
  await serve({ host: values.host, port: Number(values.port), runsDir: "runs", config: loadConfig() });
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = { transcribe, replay: replayCommand, score: scoreCommand, serve: serveCommand };
const handler = command ? commands[command] : undefined;
if (!handler) {
  console.error(USAGE);
  process.exit(1);
}
await handler(rest);
