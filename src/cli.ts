import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { countChannels, extractChannel } from "./audio.ts";
import { loadConfig } from "./config.ts";
import { transcribeConversation } from "./transcript.ts";
import { openAiCompatibleTranscriber } from "./transcription.ts";

const USAGE = `Usage:
  boxchecker transcribe <audio> [--out transcript.json]`;

async function transcribe(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const [audio] = positionals;
  if (!audio) throw new Error(USAGE);

  const config = loadConfig();
  const workDir = await mkdtemp(join(tmpdir(), "boxchecker-"));
  const transcript = await transcribeConversation(audio, {
    transcriber: openAiCompatibleTranscriber(config.transcription),
    countChannels,
    extractChannel,
    workDir,
  });

  const json = JSON.stringify(transcript, null, 2);
  if (values.out) await writeFile(values.out, json);
  else console.log(json);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<void>> = { transcribe };
const handler = command ? commands[command] : undefined;
if (!handler) {
  console.error(USAGE);
  process.exit(1);
}
await mkdir("runs", { recursive: true });
await handler(rest);
