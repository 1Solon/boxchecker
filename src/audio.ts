import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function countChannels(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=channels",
    "-of", "csv=p=0",
    file,
  ]);
  const channels = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(channels)) throw new Error(`No audio stream found in ${file}`);
  return channels;
}

/** Length of `file` in seconds. */
export async function audioDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`Could not read the length of ${file}`);
  return seconds;
}

/**
 * Writes one channel of `file` (or a mono mix when `channel` is "mix"), optionally
 * just `range` seconds of it, as the 16 kHz mono WAV that Whisper expects.
 */
export async function extractChannel(
  file: string,
  channel: number | "mix",
  out: string,
  range?: { start: number; length: number },
): Promise<void> {
  const select = channel === "mix" ? ["-ac", "1"] : ["-af", `pan=mono|c0=c${channel}`];
  const seek = range ? ["-ss", String(range.start), "-t", String(range.length)] : [];
  await run("ffmpeg", ["-y", "-v", "error", ...seek, "-i", file, ...select, "-ar", "16000", "-c:a", "pcm_s16le", out]);
}
