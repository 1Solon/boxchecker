import { spawn } from "node:child_process";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import type { Progress } from "./run.ts";
import { formatTime } from "./time.ts";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

/** The link as a URL if it points at YouTube, otherwise undefined. */
export function parseYouTubeUrl(link: string): URL | undefined {
  try {
    const url = new URL(link.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && YOUTUBE_HOSTS.has(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

export type VideoInfo = { title: string; duration: number | null };

export type Download = (
  url: URL,
  dir: string,
  hooks?: { onInfo?: (info: VideoInfo) => void; onProgress?: (progress: Progress) => void },
) => Promise<{ title: string; file: string }>;

const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/** Turns one line of yt-dlp's `BOX-PROGRESS` template output into Progress. */
export function parseDownloadProgress(line: string): Progress | undefined {
  const [, done, total, estimate, speed, eta] = line.split(" ").map(Number);
  if (!Number.isFinite(done)) return undefined;
  const size = Number.isFinite(total) ? total : Number.isFinite(estimate) ? estimate : undefined;
  const parts = [size ? `${megabytes(done!)} of ${megabytes(size)}` : megabytes(done!)];
  if (Number.isFinite(speed)) parts.push(`${megabytes(speed!)}/s`);
  if (Number.isFinite(eta)) parts.push(`${formatTime(eta!)} left`);
  return { fraction: size ? Math.min(1, done! / size) : null, detail: `Downloaded ${parts.join(" · ")}` };
}

/**
 * Downloads a video's audio track into `dir` with yt-dlp. Its stereo is an ordinary mix,
 * so callers should transcribe it with `mixChannels`.
 */
export const downloadYouTubeAudio: Download = (url, dir, { onInfo, onProgress } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", [
      // Otherwise Windows prints titles in the console's legacy code page, mangling non-ASCII.
      "--encoding", "utf-8",
      "--js-runtimes", "node",
      "--no-playlist",
      "--max-filesize", "1G",
      "--newline",
      "--progress",
      "--progress-template",
      "download:BOX-PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
      "-f", "bestaudio[ext=m4a]/bestaudio/best",
      "-P", dir,
      "-o", "input.%(ext)s",
      "--print", "before_dl:BOX-META %(duration)s %(title)s",
      "--print", "after_move:BOX-FILE %(filepath)s",
      "--no-simulate",
      "--",
      url.href,
    ]);

    let title = "";
    let file = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("BOX-META ")) {
        const [, duration, ...words] = line.split(" ");
        title = words.join(" ");
        onInfo?.({ title, duration: Number.isFinite(Number(duration)) ? Number(duration) : null });
      } else if (line.startsWith("BOX-FILE ")) {
        file = basename(line.slice("BOX-FILE ".length));
      } else if (line.startsWith("BOX-PROGRESS ")) {
        const progress = parseDownloadProgress(line);
        if (progress) onProgress?.(progress);
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (error) => reject(new Error(`Could not run yt-dlp: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0 && title && file) return resolve({ title, file });
      const reason = stderr.trim().split(/\r?\n/).findLast((line) => line.startsWith("ERROR"));
      reject(new Error(reason ?? `yt-dlp exited with code ${code}${code === 0 ? " without downloading anything" : ""}`));
    });
  });
