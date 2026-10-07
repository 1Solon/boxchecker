import type { EndpointConfig } from "./transcription.ts";

export type Config = {
  transcription: EndpointConfig;
  screening: EndpointConfig;
  verification: EndpointConfig;
  firecrawlUrl: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; see .env.example`);
  return value;
}

function endpoint(stage: string): EndpointConfig {
  const prefix = `BOXCHECKER_${stage}`;
  return {
    baseUrl: required(`${prefix}_URL`).replace(/\/$/, ""),
    model: required(`${prefix}_MODEL`),
    apiKey: process.env[`${prefix}_API_KEY`] || undefined,
  };
}

export function loadConfig(): Config {
  return {
    transcription: endpoint("TRANSCRIPTION"),
    screening: endpoint("SCREENING"),
    verification: endpoint("VERIFICATION"),
    firecrawlUrl: required("BOXCHECKER_FIRECRAWL_URL").replace(/\/$/, ""),
  };
}
