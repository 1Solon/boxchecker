import type { z } from "zod";
import type { EndpointConfig } from "./transcription.ts";

/** A language model that answers with JSON matching a schema. */
export type JsonModel = {
  json<T>(prompt: { system: string; user: string; schema: z.ZodType<T> }): Promise<T>;
};

export type ChatEndpointConfig = EndpointConfig & {
  /** Extra request fields for server-specific options, e.g. disabling a model's thinking mode. */
  extraBody?: Record<string, unknown>;
};

/** Any OpenAI-compatible `/chat/completions` endpoint that supports JSON mode. */
export function openAiCompatibleModel({ baseUrl, model, apiKey, extraBody }: ChatEndpointConfig): JsonModel {
  async function complete(system: string, user: string): Promise<string> {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...extraBody,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Model request failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("Model returned no content");
    return content;
  }

  return {
    async json({ system, user, schema }) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return schema.parse(JSON.parse(await complete(system, user)));
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}
