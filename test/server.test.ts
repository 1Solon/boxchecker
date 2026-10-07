import { mkdtemp, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplayEvent } from "../src/replay.ts";
import { createApp, parseRange, type Pipeline, type RunMessage } from "../src/server.ts";
import { parseDownloadProgress, parseYouTubeUrl, type Download } from "../src/youtube.ts";

describe("parseDownloadProgress", () => {
  it("reads yt-dlp's progress, falling back to its size estimate", () => {
    expect(parseDownloadProgress("BOX-PROGRESS 52428800 104857600 NA 2097152 25")).toEqual({
      fraction: 0.5,
      detail: "Downloaded 50.0 MB of 100.0 MB · 2.0 MB/s · 0:25 left",
    });
    expect(parseDownloadProgress("BOX-PROGRESS 1048576 NA 4194304 NA NA")).toEqual({
      fraction: 0.25,
      detail: "Downloaded 1.0 MB of 4.0 MB",
    });
    expect(parseDownloadProgress("BOX-PROGRESS 1048576 NA NA NA NA")).toEqual({ fraction: null, detail: "Downloaded 1.0 MB" });
  });
});

describe("parseYouTubeUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw", true],
    ["https://youtu.be/jNQXAC9IVRw", true],
    ["  https://m.youtube.com/watch?v=jNQXAC9IVRw  ", true],
    ["https://youtube.com.evil.example/watch?v=x", false],
    ["file:///C:/Windows/win.ini", false],
    ["--exec calc", false],
  ])("%s", (link, ok) => {
    expect(Boolean(parseYouTubeUrl(link))).toBe(ok);
  });
});

describe("parseRange", () => {
  it.each([
    [undefined, undefined],
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=900-", { start: 900, end: 999 }],
    ["bytes=-100", { start: 900, end: 999 }],
    ["bytes=990-5000", { start: 990, end: 999 }],
    ["bytes=1000-", "unsatisfiable"],
    ["bytes=0-1,5-9", undefined],
  ])("%s", (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });
});

const utterance: ReplayEvent = {
  type: "utterance",
  at: 3,
  utterance: { id: "u1", speaker: "Unknown", start: 0, end: 1, text: "Hello." },
};

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

const fakeDownload: Download = async (_url, dir, hooks) => {
  hooks?.onInfo?.({ title: "Me at the zoo", duration: 19 });
  hooks?.onProgress?.({ fraction: 1, detail: "Downloaded 0.3 MB" });
  await writeFile(join(dir, "input.m4a"), new Uint8Array(1000));
  return { title: "Me at the zoo", file: "input.m4a" };
};

async function start(pipeline: Pipeline, runsDir?: string, download: Download = fakeDownload) {
  const dir = runsDir ?? (await mkdtemp(join(tmpdir(), "boxchecker-runs-")));
  const app = createApp({ runsDir: dir, pipeline, download });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  servers.push(app);
  return { base: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, runsDir: dir };
}

async function readStream(url: string): Promise<RunMessage[]> {
  const text = await (await fetch(url)).text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

/** Reads a run's live event stream until `done` matches a message, then hangs up. */
async function readUntil(url: string, done: (message: RunMessage) => boolean): Promise<RunMessage[]> {
  const reader = (await fetch(url)).body!.getReader();
  const decoder = new TextDecoder();
  const messages: RunMessage[] = [];
  let buffer = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop()!;
    for (const part of parts.filter((p) => p.startsWith("data: "))) {
      const message: RunMessage = JSON.parse(part.slice(6));
      messages.push(message);
      if (done(message)) {
        await reader.cancel();
        return messages;
      }
    }
  }
  return messages;
}

const fakePipeline: Pipeline =async (_input, runDir, { onStage, onEvent }) => {
  onStage("transcribing", "Transcribing…");
  onStage("replaying", "Replaying…");
  onEvent(utterance);
  await writeFile(join(runDir, "events.jsonl"), JSON.stringify(utterance) + "\n");
};

describe("web app", () => {
  it("runs an uploaded recording and streams its progress", async () => {
    const { base } = await start(fakePipeline);

    const upload = await fetch(`${base}/api/runs?name=${encodeURIComponent("My call.wav")}`, {
      method: "POST",
      body: new Uint8Array(1000),
    });
    expect(upload.status).toBe(201);
    const { id } = await upload.json();
    expect(id).toMatch(/^My-call-/);

    const messages = (await readStream(`${base}/api/runs/${id}/events`)).filter((m) => m.kind !== "progress");
    expect(messages).toEqual([
      { kind: "status", status: "queued", detail: "Waiting for earlier runs to finish…" },
      { kind: "status", status: "transcribing", detail: "Transcribing…" },
      { kind: "status", status: "replaying", detail: "Replaying…" },
      { kind: "event", event: utterance },
      { kind: "status", status: "done" },
    ]);

    const runs = await (await fetch(`${base}/api/runs`)).json();
    expect(runs).toMatchObject([{ id, name: "My call.wav", status: "done", hasAudio: true }]);
  });

  it("streams progress, and tells a queued run what it is waiting for", async () => {
    let finish!: () => void;
    const { base } = await start(async (_input, runDir, { onStage, onProgress }) => {
      onStage("transcribing", "Transcribing…");
      onProgress({ fraction: 0.5, detail: "Transcribed 5:00 of 10:00" });
      await new Promise<void>((resolve) => (finish = resolve));
      await writeFile(join(runDir, "events.jsonl"), "");
    });
    const first = await (await fetch(`${base}/api/runs?name=first.wav`, { method: "POST", body: "x" })).json();
    const second = await (await fetch(`${base}/api/runs?name=second.wav`, { method: "POST", body: "x" })).json();

    const firstSeen = await readUntil(`${base}/api/runs/${first.id}/events`, (m) => m.kind === "progress");
    expect(firstSeen.at(-1)).toMatchObject({ kind: "progress", fraction: 0.5, detail: "Transcribed 5:00 of 10:00" });
    expect((firstSeen.at(-1) as { stageStartedAt: number }).stageStartedAt).toBeLessThanOrEqual(Date.now());

    const secondSeen = await readUntil(`${base}/api/runs/${second.id}/events`, (m) => m.kind === "progress");
    expect(secondSeen.at(-1)).toMatchObject({ kind: "progress", fraction: null, detail: expect.stringContaining("1 run ahead: “first.wav” (transcribing)") });
    finish();
  });

  it("downloads and runs a YouTube link, naming the run after the video", async () => {
    const { base } = await start(fakePipeline);

    const submit = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" }),
    });
    expect(submit.status).toBe(201);
    const { id } = await submit.json();
    expect(id).toMatch(/^youtube-jNQXAC9IVRw-/);

    const statuses = (await readStream(`${base}/api/runs/${id}/events`)).flatMap((m) => (m.kind === "status" ? [m.detail ?? m.status] : []));
    expect(statuses).toEqual([
      "Waiting for earlier runs to finish…",
      "Looking up https://www.youtube.com/watch?v=jNQXAC9IVRw…",
      "Downloading the audio of “Me at the zoo” (0:19 long)…",
      "Transcribing…",
      "Replaying…",
      "done",
    ]);

    const runs = await (await fetch(`${base}/api/runs`)).json();
    expect(runs).toMatchObject([{ id, name: "Me at the zoo", status: "done", hasAudio: true }]);
    expect((await fetch(`${base}/api/runs/${id}/audio`)).headers.get("content-type")).toBe("audio/mp4");
  });

  it("rejects links that are not YouTube", async () => {
    const { base } = await start(fakePipeline);
    const submit = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/call.mp3" }),
    });
    expect(submit.status).toBe(400);
  });

  it("reports a failed download", async () => {
    const { base } = await start(fakePipeline, undefined, async () => {
      throw new Error("ERROR: Video unavailable");
    });
    const { id } = await (
      await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://youtu.be/gone" }),
      })
    ).json();

    expect((await readStream(`${base}/api/runs/${id}/events`)).at(-1)).toEqual({
      kind: "status",
      status: "failed",
      detail: "Error: ERROR: Video unavailable",
    });
  });

  it("serves the recording with byte ranges so the player can seek", async () => {
    const { base } = await start(fakePipeline);
    const { id } = await (await fetch(`${base}/api/runs?name=a.mp3`, { method: "POST", body: new Uint8Array(1000) })).json();

    const partial = await fetch(`${base}/api/runs/${id}/audio`, { headers: { Range: "bytes=100-199" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-type")).toBe("audio/mpeg");
    expect(partial.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect((await partial.arrayBuffer()).byteLength).toBe(100);
  });

  it("replays a finished run from disk after a restart", async () => {
    const first = await start(fakePipeline);
    const { id } = await (await fetch(`${first.base}/api/runs?name=a.wav`, { method: "POST", body: "x" })).json();
    await readStream(`${first.base}/api/runs/${id}/events`);

    const second = await start(fakePipeline, first.runsDir);
    expect(await readStream(`${second.base}/api/runs/${id}/events`)).toEqual([
      { kind: "event", event: utterance },
      { kind: "status", status: "done" },
    ]);
  });

  it("reports a failed run", async () => {
    const { base } = await start(async () => {
      throw new Error("whisper-server is not running");
    });
    const { id } = await (await fetch(`${base}/api/runs?name=a.wav`, { method: "POST", body: "x" })).json();

    expect((await readStream(`${base}/api/runs/${id}/events`)).at(-1)).toEqual({
      kind: "status",
      status: "failed",
      detail: "Error: whisper-server is not running",
    });
  });

  it("deletes a finished run and its recording", async () => {
    const { base, runsDir } = await start(fakePipeline);
    const { id } = await (await fetch(`${base}/api/runs?name=a.wav`, { method: "POST", body: "x" })).json();
    await readStream(`${base}/api/runs/${id}/events`);

    expect((await fetch(`${base}/api/runs/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await (await fetch(`${base}/api/runs`)).json()).toEqual([]);
    expect((await fetch(`${base}/api/runs/${id}/audio`)).status).toBe(404);
    await expect(stat(join(runsDir, id))).rejects.toThrow();
    expect((await fetch(`${base}/api/runs/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("refuses to delete a run that is still in progress", async () => {
    let finish!: () => void;
    const { base } = await start(() => new Promise<void>((resolve) => (finish = resolve)));
    const { id } = await (await fetch(`${base}/api/runs?name=a.wav`, { method: "POST", body: "x" })).json();

    expect((await fetch(`${base}/api/runs/${id}`, { method: "DELETE" })).status).toBe(409);
    finish();
    await readStream(`${base}/api/runs/${id}/events`);
    expect((await fetch(`${base}/api/runs/${id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("rejects files that are not audio, and paths outside the runs folder", async () => {
    const { base } = await start(fakePipeline);

    expect((await fetch(`${base}/api/runs?name=notes.txt`, { method: "POST", body: "x" })).status).toBe(415);
    expect((await fetch(`${base}/api/runs/..%2F..%2Fetc/audio`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs/..%2F..%2Fetc`, { method: "DELETE" })).status).toBe(404);
  });

  it("serves the page", async () => {
    const { base } = await start(fakePipeline);
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Drop a recording");
  });
});
