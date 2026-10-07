import { formatTime } from "./time.ts";
import type { ReplayEvent } from "./replay.ts";

const REASONS = {
  verdict: "verdict not Refuted/Misleading",
  confidence: "not high confidence",
  unimportant: "unimportant",
  "already-corrected": "already corrected",
  "rate-limited": "rate-limited",
} as const;

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Renders a Replay's events as a human-readable Markdown report. */
export function renderReport(events: ReplayEvent[], { title, transcriptionDelay }: { title: string; transcriptionDelay: number }): string {
  const of = <T extends ReplayEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<ReplayEvent, { type: T }> => e.type === type);

  const utterances = new Map(of("utterance").map((e) => [e.utterance.id, e.utterance]));
  const claims = of("claim");
  const verifications = new Map(of("verification").map((e) => [e.claimId, e]));
  const decisions = new Map(of("decision").map((e) => [e.claimId, e.decision]));
  const repeats = of("repeat");
  const interjections = of("interjection");
  const errors = of("error");

  const saidAt = (utteranceIds: string[]) => utterances.get(utteranceIds.at(-1)!)!.end;
  const delays = claims
    .map((c) => {
      const v = verifications.get(c.claim.id);
      return v ? v.at - saidAt(c.claim.utteranceIds) : undefined;
    })
    .filter((d) => d !== undefined)
    .sort((a, b) => a - b);
  const median = delays.length ? delays[Math.floor(delays.length / 2)]! : undefined;
  const counts = new Map<string, number>();
  for (const v of verifications.values()) counts.set(v.verdict.label, (counts.get(v.verdict.label) ?? 0) + 1);

  const lines: string[] = [`# ${title}`, ""];

  lines.push(
    "## Summary",
    "",
    `- **Utterances:** ${utterances.size}`,
    `- **Claims:** ${claims.length} (${repeats.length} repeats recognised)`,
    `- **Verdicts:** ${[...counts].map(([label, n]) => `${n} ${label}`).join(", ") || "none"}`,
    `- **Interjections:** ${interjections.length}`,
    `- **Delay from Claim to Verdict:** median ${median?.toFixed(1) ?? "–"}s, max ${delays.at(-1)?.toFixed(1) ?? "–"}s (includes an assumed ${transcriptionDelay}s transcription delay)`,
  );
  if (errors.length) lines.push(`- **Errors:** ${errors.length}`);
  lines.push("");

  lines.push("## Interjections", "");
  if (!interjections.length) lines.push("_None._");
  for (const i of interjections) lines.push(`- **[${formatTime(i.at)}]** ${i.text}`);
  lines.push("");

  lines.push(
    "## Claims",
    "",
    "| # | Said | Claim | Verdict | Delay | Interjection |",
    "|---|---|---|---|---|---|",
  );
  for (const { claim } of claims) {
    const v = verifications.get(claim.id);
    const d = decisions.get(claim.id);
    const said = saidAt(claim.utteranceIds);
    lines.push(
      `| ${claim.id} | ${formatTime(said)} | ${cell(claim.text)} | ${v ? `${v.verdict.label} (${v.verdict.confidence})` : "error"} | ${v ? `${(v.at - said).toFixed(1)}s` : "–"} | ${d ? (d.interject ? "**yes**" : REASONS[d.reason]) : "–"} |`,
    );
  }
  lines.push("");

  for (const { claim } of claims) {
    const v = verifications.get(claim.id);
    lines.push(`### ${claim.id}: ${claim.text}`, "", `> ${claim.speaker} at ${formatTime(saidAt(claim.utteranceIds))}: "${claim.quote}"`, "");
    if (v) {
      lines.push(
        `**${v.verdict.label}** (${v.verdict.confidence} confidence${v.verdict.important ? "" : ", unimportant"}${v.verdict.readPages ? ", read full pages" : ""}): ${v.verdict.explanation}`,
        "",
        ...v.verdict.sources.map((s) => `- [${s.title}](${s.url})`),
      );
    }
    const repeatedAt = repeats.filter((r) => r.claimId === claim.id);
    if (repeatedAt.length) lines.push("", `Repeated at ${repeatedAt.map((r) => formatTime(r.at)).join(", ")}.`);
    lines.push("");
  }

  if (errors.length) {
    lines.push("## Errors", "");
    for (const e of errors) lines.push(`- [${formatTime(e.at)}] ${e.stage} of ${e.subject}: ${e.message}`);
    lines.push("");
  }

  const claimsByUtterance = new Map<string, string[]>();
  for (const { claim } of claims) {
    const last = claim.utteranceIds.at(-1)!;
    claimsByUtterance.set(last, [...(claimsByUtterance.get(last) ?? []), claim.id]);
  }
  lines.push("## Transcript", "");
  for (const u of utterances.values()) {
    const found = claimsByUtterance.get(u.id);
    lines.push(`**[${formatTime(u.start)}] ${u.speaker}:** ${u.text}${found ? ` _(${found.join(", ")})_` : ""}`, "");
  }

  return lines.join("\n");
}
