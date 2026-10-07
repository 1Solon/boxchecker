import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import type { Segment } from "./transcript.ts";

/** Turns one Speaker's audio into timed Segments. */
export type Transcriber = {
  transcribe(wavFile: string): Promise<Segment[]>;
};

export type EndpointConfig = {
  /** Base URL including the version prefix, e.g. http://localhost:8178/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
};

const VerboseJson = z.object({
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});

/**
 * Any OpenAI-compatible `/audio/transcriptions` endpoint that supports
 * `response_format=verbose_json` (OpenAI whisper-1, whisper.cpp's whisper-server, Groq, ...).
 */
export function openAiCompatibleTranscriber({ baseUrl, model, apiKey }: EndpointConfig): Transcriber {
  return {
    async transcribe(wavFile) {
      const form = new FormData();
      form.set("file", await openAsBlob(wavFile, { type: "audio/wav" }), basename(wavFile));
      form.set("model", model);
      form.set("response_format", "verbose_json");
      form.set("language", "en");
      form.set("temperature", "0");

      const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
      });
      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.status} ${await response.text()}`);
      }
      return VerboseJson.parse(await response.json()).segments;
    },
  };
}
