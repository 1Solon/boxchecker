<img src="assets/icon.svg" width="64" height="64" alt="">

# BoxChecker

Listens to a spoken conversation and fact-checks its claims as it unfolds. See [CONTEXT.md](CONTEXT.md) for the domain language and [docs/adr](docs/adr) for key decisions.

## Setup

Requires Node 24+, pnpm, ffmpeg, [yt-dlp](https://github.com/yt-dlp/yt-dlp) (for YouTube links), a Whisper server, an OpenAI-compatible chat model, and a [Firecrawl](https://firecrawl.dev) instance.

```sh
brew install ffmpeg yt-dlp whisper-cpp
curl -L -o ~/.cache/whisper-cpp/ggml-large-v3-turbo.bin --create-dirs \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
whisper-server -m ~/.cache/whisper-cpp/ggml-large-v3-turbo.bin \
  --port 8178 --inference-path /v1/audio/transcriptions

pnpm install
cp .env.example .env   # then point each stage at your endpoints
```

## Usage

```sh
# Transcribe a recording (stereo: one Speaker per channel; mono: one Unknown Speaker)
pnpm boxchecker transcribe call.mp4 --out call.transcript.json

# Replay a recording or a saved transcript as if live; writes runs/<name>-<time>/{transcript.json,events.jsonl,report.md}
pnpm boxchecker replay call.transcript.json

# Score a run against the recording's Planted Claims
pnpm boxchecker score runs/<run> call.answers.yaml

# Web app: drag a recording in (or paste a YouTube link) and watch it get fact-checked (listens on the LAN by default)
pnpm boxchecker serve --port 8790
```

An answer key lists each Planted Claim, roughly when it is said, and the expected outcome:

```yaml
claims:
  - at: "1:05"
    claim: France beat Brazil 2-0 in the 1998 World Cup final.
    verdict: refuted        # supported | refuted | misleading | unverifiable
    interject: true
```

## Current limitations

- **Recorded audio only.** Conversations are replayed from a file or a YouTube video; there is no live or Discord input yet.
- **At most two speakers**, one per stereo channel. Mono files are attributed to a single unknown speaker.
- **English only.**
