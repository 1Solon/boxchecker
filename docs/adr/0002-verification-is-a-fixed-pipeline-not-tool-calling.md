# Verification is a fixed pipeline, not model tool-calling

Verification runs as fixed steps — the model writes search queries, BoxChecker runs them against the search provider, the model judges the Claim against the results (fetching full pages only if snippets leave the Verdict Unverifiable or low-confidence) — rather than letting the model call a search tool itself. We want any OpenAI-compatible endpoint, including local ones, to work as the model; tool-calling support and quality vary widely across those servers, whereas producing JSON does not.
