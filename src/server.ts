import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join } from "node:path";
import { pipeline as pipe } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import type { ReplayEvent } from "./replay.ts";
import { readEvents, runReplay, type Progress, type Stage } from "./run.ts";
import { formatTime } from "./time.ts";
import { downloadYouTubeAudio, parseYouTubeUrl, type Download } from "./youtube.ts";

export type Status = "queued" | "downloading" | Stage | "done" | "failed";

/**
 * What a browser hears about a run, in order. Progress is within the current status and
 * only the latest is kept; `stageStartedAt` (epoch ms) lets the browser show elapsed time and an ETA.
 */
export type RunMessage =
  | { kind: "status"; status: Status; detail?: string }
  | { kind: "event"; event: ReplayEvent }
  | ({ kind: "progress"; stageStartedAt: number } & Progress);

export type Pipeline = (
  input: string,
  runDir: string,
  hooks: {
    name: string;
    mixChannels?: boolean;
    onStage: (stage: Stage, detail: string) => void;
    onEvent: (event: ReplayEvent) => void;
    onProgress: (progress: Progress) => void;
  },
) => Promise<void>;

type RunMeta = { name: string; audio: string; createdAt: string; url?: string };

type LiveRun = {
  name: string;
  status: Status;
  detail?: string;
  stageStartedAt: number;
  messages: RunMessage[];
  progress?: RunMessage & { kind: "progress" };
  progressSentAt: number;
  listeners: Set<(message: RunMessage) => void>;
};

/** Progress updates closer together than this are dropped, except a stage's first and its completion. */
const PROGRESS_INTERVAL_MS = 250;

export const AUDIO_TYPES: Record<string, string> = {
  ".mp4": "audio/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

const WEB_FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const MAX_UPLOAD_BYTES = 1024 ** 3;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parses an HTTP Range header for a file of `size` bytes; undefined means "send it all". */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const [, from, to] = match;
  let start: number;
  let end: number;
  if (from === "") {
    if (to === "") return undefined;
    start = Math.max(0, size - Number(to));
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function slug(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "recording"
  );
}

async function text(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error("Request body too large");
  }
  return body;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The BoxChecker web app: drop in a recording, watch it get fact-checked. */
export function createApp({
  runsDir,
  webDir = fileURLToPath(new URL("../web/", import.meta.url)),
  pipeline,
  download = downloadYouTubeAudio,
}: {
  runsDir: string;
  webDir?: string;
  pipeline: Pipeline;
  download?: Download;
}): Server {
  const live = new Map<string, LiveRun>();
  // One run at a time, so runs do not slow each other down and distort measured delays.
  let queue = Promise.resolve();
  let active: LiveRun | undefined;
  const waiting: LiveRun[] = [];

  function publish(run: LiveRun, message: RunMessage) {
    if (message.kind === "status") {
      if (message.status !== run.status) run.stageStartedAt = Date.now();
      run.status = message.status;
      run.detail = message.detail;
      run.progress = undefined;
    }
    run.messages.push(message);
    for (const listener of run.listeners) listener(message);
  }

  function publishProgress(run: LiveRun, progress: Progress) {
    const now = Date.now();
    const first = !run.progress;
    run.progress = { kind: "progress", stageStartedAt: run.stageStartedAt, ...progress };
    if (!first && progress.fraction !== 1 && now - run.progressSentAt < PROGRESS_INTERVAL_MS) return;
    run.progressSentAt = now;
    for (const listener of run.listeners) listener(run.progress);
  }

  function announceQueue() {
    for (const [i, run] of waiting.entries()) {
      const ahead = [active, ...waiting.slice(0, i)].filter((r) => r !== undefined);
      const names = ahead.map((r) => `“${r.name}” (${r.status})`).join(", ");
      publishProgress(run, {
        fraction: null,
        detail: `${ahead.length} run${ahead.length === 1 ? "" : "s"} ahead: ${names}. Runs go one at a time so their timings stay accurate.`,
      });
    }
  }

  async function readMeta(id: string): Promise<RunMeta | undefined> {
    try {
      return JSON.parse(await readFile(join(runsDir, id, "run.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  async function exists(path: string) {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async function listRuns() {
    await mkdir(runsDir, { recursive: true });
    const entries = await readdir(runsDir, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter((e) => e.isDirectory() && RUN_ID.test(e.name))
        .map(async ({ name: id }) => {
          const meta = await readMeta(id);
          const finished = await exists(join(runsDir, id, "events.jsonl"));
          const status: Status = live.get(id)?.status ?? (finished ? "done" : "failed");
          if (!meta && !finished) return undefined;
          const createdAt = meta?.createdAt ?? (await stat(join(runsDir, id))).mtime.toISOString();
          return { id, name: meta?.name ?? id, status, createdAt, hasAudio: Boolean(meta?.audio), url: meta?.url };
        }),
    );
    return runs.filter((r) => r !== undefined).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Creates a run folder and queues `prepare` (which returns the recording's path) followed by the pipeline. */
  async function enqueue(
    id: string,
    meta: RunMeta,
    prepare: (runDir: string, run: LiveRun) => Promise<{ input: string; name: string; mixChannels?: boolean }>,
  ) {
    const runDir = join(runsDir, id);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), JSON.stringify(meta, null, 2));

    const run: LiveRun = {
      name: meta.name,
      status: "queued",
      stageStartedAt: Date.now(),
      messages: [],
      progressSentAt: 0,
      listeners: new Set(),
    };
    live.set(id, run);
    publish(run, { kind: "status", status: "queued", detail: "Waiting for earlier runs to finish…" });
    waiting.push(run);
    announceQueue();
    queue = queue.then(async () => {
      waiting.shift();
      active = run;
      announceQueue();
      try {
        const { input, name, mixChannels } = await prepare(runDir, run);
        await pipeline(input, runDir, {
          name,
          mixChannels,
          onStage: (status, detail) => {
            publish(run, { kind: "status", status, detail });
            announceQueue();
          },
          onEvent: (event) => publish(run, { kind: "event", event }),
          onProgress: (progress) => publishProgress(run, progress),
        });
        publish(run, { kind: "status", status: "done" });
      } catch (error) {
        publish(run, { kind: "status", status: "failed", detail: String(error) });
      } finally {
        active = undefined;
      }
    });
  }

  const runId = (name: string) => `${slug(name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  async function startUpload(req: IncomingMessage, res: ServerResponse, url: URL) {
    const name = url.searchParams.get("name") ?? "recording";
    const ext = extname(name).toLowerCase();
    if (!AUDIO_TYPES[ext]) return json(res, 415, { error: `Unsupported file type "${ext}"` });
    if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) return json(res, 413, { error: "File too large" });

    const id = runId(name);
    const audio = `input${ext}`;
    await mkdir(join(runsDir, id), { recursive: true });
    await pipe(req, createWriteStream(join(runsDir, id, audio)));
    await enqueue(id, { name, audio, createdAt: new Date().toISOString() }, async (runDir) => ({ input: join(runDir, audio), name }));
    json(res, 201, { id });
  }

  async function startLink(req: IncomingMessage, res: ServerResponse) {
    let body: { url?: unknown };
    try {
      body = JSON.parse(await text(req));
    } catch {
      return json(res, 400, { error: "Expected a JSON body" });
    }
    const link = typeof body.url === "string" ? parseYouTubeUrl(body.url) : undefined;
    if (!link) return json(res, 400, { error: "Only YouTube links are supported" });

    const videoId = link.hostname === "youtu.be" ? link.pathname.slice(1) : (link.searchParams.get("v") ?? link.pathname.split("/").at(-1));
    const id = runId(`youtube-${videoId}`);
    const meta: RunMeta = { name: link.href, audio: "", createdAt: new Date().toISOString(), url: link.href };
    await enqueue(id, meta, async (runDir, run) => {
      publish(run, { kind: "status", status: "downloading", detail: `Looking up ${link.href}…` });
      let saved = Promise.resolve();
      const { title, file } = await download(link, runDir, {
        onInfo: ({ title, duration }) => {
          run.name = title;
          saved = writeFile(join(runDir, "run.json"), JSON.stringify({ ...meta, name: title }, null, 2));
          const length = duration ? ` (${formatTime(duration)} long)` : "";
          publish(run, { kind: "status", status: "downloading", detail: `Downloading the audio of “${title}”${length}…` });
          announceQueue();
        },
        onProgress: (progress) => publishProgress(run, progress),
      });
      await saved;
      await writeFile(join(runDir, "run.json"), JSON.stringify({ ...meta, name: title, audio: file }, null, 2));
      // A video's stereo is an ordinary mix, not one Speaker per channel.
      return { input: join(runDir, file), name: title, mixChannels: true };
    });
    json(res, 201, { id });
  }

  async function streamRun(req: IncomingMessage, res: ServerResponse, id: string) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (message: RunMessage) => res.write(`data: ${JSON.stringify(message)}\n\n`);

    const run = live.get(id);
    if (!run) {
      try {
        for (const event of await readEvents(join(runsDir, id))) send({ kind: "event", event });
        send({ kind: "status", status: "done" });
      } catch {
        send({ kind: "status", status: "failed", detail: "This run did not finish." });
      }
      return res.end();
    }
    for (const message of run.messages) send(message);
    if (run.status === "done" || run.status === "failed") return res.end();
    if (run.progress) send(run.progress);
    const listener = (message: RunMessage) => {
      send(message);
      if (message.kind === "status" && (message.status === "done" || message.status === "failed")) {
        run.listeners.delete(listener);
        res.end();
      }
    };
    run.listeners.add(listener);
    req.on("close", () => run.listeners.delete(listener));
  }

  async function deleteRun(res: ServerResponse, id: string) {
    const status = live.get(id)?.status;
    if (status && status !== "done" && status !== "failed") return json(res, 409, { error: "This run is still in progress" });
    const runDir = join(runsDir, id);
    if (!(await exists(runDir))) return json(res, 404, { error: "No such run" });
    await rm(runDir, { recursive: true, force: true, maxRetries: 5 });
    live.delete(id);
    res.writeHead(204);
    res.end();
  }

  async function serveAudio(req: IncomingMessage, res: ServerResponse, id: string) {
    const meta = await readMeta(id);
    if (!meta?.audio) return json(res, 404, { error: "No audio for this run" });
    const file = join(runsDir, id, meta.audio);
    const { size } = await stat(file);
    const type = AUDIO_TYPES[extname(meta.audio)] ?? "application/octet-stream";
    const range = parseRange(req.headers.range, size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    if (!range) {
      res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
      return pipe(createReadStream(file), res);
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Accept-Ranges": "bytes",
    });
    await pipe(createReadStream(file, range), res);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const web = WEB_FILES[url.pathname];
    if (req.method === "GET" && web) {
      res.writeHead(200, { "Content-Type": web[1] });
      return res.end(await readFile(join(webDir, web[0])));
    }
    if (url.pathname === "/api/runs") {
      if (req.method === "GET") return json(res, 200, await listRuns());
      if (req.method === "POST") {
        return req.headers["content-type"]?.startsWith("application/json") ? startLink(req, res) : startUpload(req, res, url);
      }
    }
    const run = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (req.method === "DELETE" && run && RUN_ID.test(run[1]!)) return deleteRun(res, run[1]!);
    const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/(events|audio|report\.md)$/);
    if (req.method === "GET" && match && RUN_ID.test(match[1]!)) {
      const [, id, what] = match as unknown as [string, string, string];
      if (what === "events") return streamRun(req, res, id);
      if (what === "audio") return serveAudio(req, res, id);
      try {
        const report = await readFile(join(runsDir, id, "report.md"));
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${id}.md"`,
        });
        return res.end(report);
      } catch {
        return json(res, 404, { error: "No report yet" });
      }
    }
    json(res, 404, { error: "Not found" });
  }

  return createServer((req, res) => {
    route(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: String(error) });
      else res.end();
    });
  });
}

export async function serve({ host, port, runsDir, config }: { host: string; port: number; runsDir: string; config: Config }) {
  const app = createApp({
    runsDir,
    pipeline: async (input, runDir, { name, ...hooks }) => {
      await runReplay(input, runDir, config, { title: `BoxChecker replay: ${name}`, ...hooks });
    },
  });
  await new Promise<void>((resolve) => app.listen(port, host, resolve));

  const addresses =
    host === "0.0.0.0"
      ? Object.values(networkInterfaces())
          .flat()
          .filter((i) => i?.family === "IPv4")
          .map((i) => i!.address)
      : [host];
  for (const address of addresses) console.error(`BoxChecker listening on http://${address}:${port}/`);
}
