import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReplayEvent } from "../src/replay.ts";
import { createApp, parseRange, type Pipeline, type RunMessage } from "../src/server.ts";

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

async function start(pipeline: Pipeline, runsDir?: string) {
  const dir = runsDir ?? (await mkdtemp(join(tmpdir(), "boxchecker-runs-")));
  const app = createApp({ runsDir: dir, pipeline });
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

const fakePipeline: Pipeline = async (_input, runDir, { onStage, onEvent }) => {
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

    const messages = await readStream(`${base}/api/runs/${id}/events`);
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

  it("rejects files that are not audio, and paths outside the runs folder", async () => {
    const { base } = await start(fakePipeline);

    expect((await fetch(`${base}/api/runs?name=notes.txt`, { method: "POST", body: "x" })).status).toBe(415);
    expect((await fetch(`${base}/api/runs/..%2F..%2Fetc/audio`)).status).toBe(404);
  });

  it("serves the page", async () => {
    const { base } = await start(fakePipeline);
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Drop a recording");
  });
});
