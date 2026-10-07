<img src="assets/icon.svg" width="64" height="64" alt="">

# BoxChecker

Created in [T3 Code](https://t3.codes).

Listens to a spoken conversation and fact-checks its claims as it unfolds. See [CONTEXT.md](CONTEXT.md) for the domain language and [docs/adr](docs/adr) for key decisions.

## Current limitations

- **Recorded audio only.** Conversations are replayed from a file; there is no live or Discord input yet.
- **At most two speakers**, one per stereo channel. Mono files are attributed to a single unknown speaker.
- **English only.**
