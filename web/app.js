// BoxChecker web app: upload a recording, then render its run as events stream in.
// Event shapes are ReplayEvent and RunMessage in src/replay.ts and src/server.ts.

const $ = (id) => document.getElementById(id);

const escape = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const seekButton = (seconds, label = formatTime(seconds)) =>
  `<button class="ts" data-seek="${seconds}">${escape(label)}</button>`;

const REASONS = {
  verdict: "Not Refuted or Misleading",
  confidence: "Not high confidence",
  unimportant: "Judged unimportant",
  "already-corrected": "Already corrected in the conversation",
  "rate-limited": "Held back: interjected too recently",
};

const STATUS = {
  queued: "Queued",
  downloading: "Downloading…",
  transcribing: "Transcribing…",
  replaying: "Fact-checking…",
  done: "Done",
  failed: "Failed",
};

let current = null; // { id, source, state }

function emptyState() {
  return {
    status: null, // until the first message arrives
    detail: "",
    utterances: new Map(),
    claims: new Map(),
    verifications: new Map(),
    decisions: new Map(),
    interjections: new Map(),
    repeats: [],
    errors: [],
    progress: null, // latest { fraction, detail, stageStartedAt } within the current status
    stageSeenAt: Date.now(),
    failedStage: null,
  };
}

function apply(state, message) {
  if (message.kind === "progress") {
    state.progress = message;
    return;
  }
  if (message.kind === "status") {
    if (message.status !== state.status) {
      if (message.status === "failed") state.failedStage = state.status;
      state.stageSeenAt = Date.now();
      state.progress = null;
    }
    state.status = message.status;
    state.detail = message.detail ?? "";
    return;
  }
  const e = message.event;
  switch (e.type) {
    case "utterance":
      state.utterances.set(e.utterance.id, e.utterance);
      break;
    case "claim":
      state.claims.set(e.claim.id, e);
      break;
    case "repeat":
      state.repeats.push(e);
      break;
    case "verification":
      state.verifications.set(e.claimId, e);
      break;
    case "decision":
      state.decisions.set(e.claimId, e);
      break;
    case "interjection":
      state.interjections.set(e.claimId, e);
      break;
    case "error":
      state.errors.push(e);
      break;
  }
}

/* ---------- rendering ---------- */

let frame = 0;
function scheduleRender() {
  if (!frame) frame = requestAnimationFrame(() => ((frame = 0), render()));
}

function saidAt(state, claim) {
  return state.utterances.get(claim.utteranceIds.at(-1))?.end ?? 0;
}

function sources(verdict) {
  if (!verdict.sources.length) return "";
  return `<ul class="sources">${verdict.sources
    .map((s) => `<li><a href="${escape(s.url)}" target="_blank" rel="noreferrer">${escape(s.title)}</a></li>`)
    .join("")}</ul>`;
}

function render() {
  if (!current) return;
  const s = current.state;
  const working = !["done", "failed"].includes(s.status);

  const status = $("run-status");
  const heard = s.utterances.size;
  status.textContent = s.status === "failed" ? `Failed: ${s.detail}` : (STATUS[s.status] ?? "Loading…");
  status.className = `status ${working ? "working" : s.status}`;
  renderProgress();
  $("run-report").hidden = s.status !== "done";
  $("run-delete").hidden = working;

  // Stats
  const claims = [...s.claims.values()].sort((a, b) => saidAt(s, a.claim) - saidAt(s, b.claim));
  const delays = claims
    .map((c) => s.verifications.get(c.claim.id) && s.verifications.get(c.claim.id).at - saidAt(s, c.claim))
    .filter((d) => d !== undefined)
    .sort((a, b) => a - b);
  const median = delays.length ? `${delays[Math.floor(delays.length / 2)].toFixed(1)}s` : "–";
  const stat = (value, label) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  $("stats").innerHTML = [
    stat(heard, "Utterances"),
    stat(s.claims.size, `Claims (${s.repeats.length} repeats)`),
    stat(`${s.verifications.size}/${s.claims.size}`, "Verified"),
    stat(s.interjections.size, "Interjections"),
    stat(median, "Median delay to Verdict"),
  ].join("");

  // Interjections
  const interjections = [...s.interjections.values()].sort((a, b) => a.at - b.at);
  $("interjections").innerHTML = interjections.length
    ? `<h2>Interjections</h2>${interjections
        .map((i) => {
          const claim = s.claims.get(i.claimId)?.claim;
          const v = s.verifications.get(i.claimId)?.verdict;
          return `<div class="interjection">${seekButton(i.at)}<p>🔍 <span class="badge ${v?.label}">${v?.label ?? ""}</span>
            <em>“${escape(claim?.text ?? "")}”</em> ${escape(v?.explanation ?? "")}
            ${(v?.sources ?? []).map((src) => `<a href="${escape(src.url)}" target="_blank" rel="noreferrer">${escape(src.title)}</a>`).join(" · ")}</p></div>`;
        })
        .join("")}`
    : "";

  // Claims
  $("claims").innerHTML =
    claims
      .map(({ claim }) => {
        const v = s.verifications.get(claim.id);
        const d = s.decisions.get(claim.id)?.decision;
        const interjection = s.interjections.get(claim.id);
        const repeats = s.repeats.filter((r) => r.claimId === claim.id);
        const said = saidAt(s, claim);
        const failed = s.errors.find((e) => e.stage === "verification" && e.subject === claim.id);
        return `<article class="claim ${v?.verdict.label ?? ""} ${interjection ? "interjected" : ""}" id="claim-${claim.id}">
          <div class="claim-head">
            ${seekButton(said)} <span>${escape(claim.speaker)}</span> <span>${claim.id}</span>
            ${v ? `<span class="badge ${v.verdict.label}">${v.verdict.label}</span><span class="badge light">${v.verdict.confidence} confidence</span>` : ""}
            ${v ? `<span>Verdict after ${(v.at - said).toFixed(1)}s</span>` : ""}
            ${v?.verdict.readPages ? `<span>read full pages</span>` : ""}
          </div>
          <p class="claim-text">${escape(claim.text)}</p>
          <p class="quote">“${escape(claim.quote)}”</p>
          ${
            v
              ? `<p class="explanation">${escape(v.verdict.explanation)}</p>${sources(v.verdict)}`
              : failed
                ? `<p class="error">Verification failed: ${escape(failed.message)}</p>`
                : `<p class="pending">Verifying…</p>`
          }
          ${repeats.length ? `<div class="decision">Repeated at ${repeats.map((r) => seekButton(r.at)).join(", ")}</div>` : ""}
          ${
            interjection
              ? `<div class="decision yes">Interjected at ${seekButton(interjection.at)}</div>`
              : d
                ? `<div class="decision">No Interjection: ${REASONS[d.reason] ?? d.reason}</div>`
                : ""
          }
        </article>`;
      })
      .join("") || `<p class="pending">${working ? "Listening for Claims…" : "No Claims found."}</p>`;

  // Transcript
  const claimsByUtterance = new Map();
  for (const { claim } of claims) {
    const last = claim.utteranceIds.at(-1);
    claimsByUtterance.set(last, [...(claimsByUtterance.get(last) ?? []), claim.id]);
  }
  const transcript = $("transcript");
  const scroll = transcript.scrollTop;
  transcript.innerHTML =
    [...s.utterances.values()]
      .sort((a, b) => a.start - b.start)
      .map((u) => {
        const tags = (claimsByUtterance.get(u.id) ?? [])
          .map((id) => `<a href="#claim-${id}" class="badge light" data-claim="${id}">${id}</a>`)
          .join(" ");
        return `<div class="utterance ${tags ? "has-claim" : ""}" data-start="${u.start}" data-end="${u.end}">
          <div class="who">${seekButton(u.start)} ${escape(u.speaker)}<span class="tags">${tags}</span></div>
          <p>${escape(u.text)}</p>
        </div>`;
      })
      .join("") || `<p class="pending" style="padding: 0 16px">${s.status === "transcribing" ? "Transcribing…" : "Waiting…"}</p>`;
  transcript.scrollTop = scroll;

  $("errors").innerHTML = s.errors
    .filter((e) => e.stage === "screening")
    .map((e) => `<p class="error">[${formatTime(e.at)}] Screening failed on ${escape(e.subject)}: ${escape(e.message)}</p>`)
    .join("");

  highlightPlaying();
}

/* ---------- progress ---------- */

const formatDuration = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

function renderProgress() {
  if (!current) return;
  const s = current.state;
  const working = !["done", "failed"].includes(s.status);
  const panel = $("progress");
  panel.hidden = s.status === "done" || s.status === null;
  if (panel.hidden) return;

  // Steps: the run's path through the pipeline, with where it is (or where it failed).
  const steps = [
    ["queued", "Queued"],
    ...(current.fromLink ? [["downloading", "Download"]] : []),
    ["transcribing", "Transcribe"],
    ["replaying", "Fact-check"],
    ["done", "Done"],
  ];
  const at = steps.findIndex(([key]) => key === (s.status === "failed" ? s.failedStage : s.status));
  $("steps").innerHTML = steps
    .map(([key, label], i) => {
      const state = i < at ? "complete" : i === at ? (s.status === "failed" ? "failed" : "current") : "";
      return `<li class="${state}" data-step="${key}">${label}</li>`;
    })
    .join("");

  // Bar: real progress when the stage reports it, otherwise an indeterminate stripe.
  const fraction = s.progress?.fraction;
  const fill = $("bar-fill");
  const known = typeof fraction === "number";
  fill.className = `bar-fill ${s.status === "failed" ? "failed" : working && !known ? "indeterminate" : ""}`;
  fill.style.width = s.status === "failed" ? "100%" : known ? `${(fraction * 100).toFixed(1)}%` : "";
  panel.classList.toggle("failed", s.status === "failed");

  const label = STATUS[s.status] ?? s.status;
  $("progress-detail").textContent =
    s.status === "failed"
      ? s.detail || "This run did not finish."
      : [label, known ? `${Math.floor(fraction * 100)}%` : "", s.progress?.detail || s.detail].filter(Boolean).join(" · ");

  // Time: how long this stage has run, and a rough ETA once there is enough progress to go on.
  let time = "";
  if (working) {
    const elapsed = (Date.now() - (s.progress?.stageStartedAt ?? s.stageSeenAt)) / 1000;
    time = `${formatDuration(elapsed)} elapsed`;
    if (known && fraction > 0.02 && fraction < 1 && elapsed > 3) time += ` · about ${formatDuration((elapsed * (1 - fraction)) / fraction)} left`;
  }
  $("progress-time").textContent = time;

  // Mirror it in the sidebar entry so the run's state is visible from the list.
  const meta = document.querySelector(`[data-run="${CSS.escape(current.id)}"] .meta`);
  if (meta && working) meta.textContent = `${label}${known ? ` ${Math.floor(fraction * 100)}%` : ""}`;
}

// Keep elapsed time and ETA ticking between server updates.
setInterval(() => current && !["done", "failed"].includes(current.state.status) && renderProgress(), 1000);

/* ---------- audio ---------- */

const audio = $("audio");

function highlightPlaying() {
  const t = audio.currentTime;
  let playing = null;
  for (const el of document.querySelectorAll(".utterance")) {
    const on = !audio.paused || t > 0 ? t >= Number(el.dataset.start) && t <= Number(el.dataset.end) + 0.5 : false;
    el.classList.toggle("current", on);
    if (on) playing = el;
  }
  if (playing && !audio.paused && $("follow").checked) {
    const box = $("transcript");
    const top = playing.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - playing.clientHeight) {
      box.scrollTo({ top: top - box.clientHeight / 3, behavior: "smooth" });
    }
  }
}
audio.addEventListener("timeupdate", highlightPlaying);

document.addEventListener("click", (e) => {
  const seek = e.target.closest("[data-seek]");
  if (!seek || audio.closest("[hidden]")) return;
  e.preventDefault();
  audio.currentTime = Math.max(0, Number(seek.dataset.seek) - (seek.closest(".utterance") ? 0 : 3));
  audio.play();
});

/* ---------- runs ---------- */

async function loadRuns() {
  const runs = await (await fetch("/api/runs")).json();
  $("runs").innerHTML =
    runs
      .map(
        (r) => `<li><a href="#run=${encodeURIComponent(r.id)}" class="${current?.id === r.id ? "active" : ""}" data-run="${escape(r.id)}">
          <span class="name">${escape(r.name)}</span>
          <span class="meta">${new Date(r.createdAt).toLocaleString()} · ${STATUS[r.status] ?? r.status}</span>
        </a></li>`,
      )
      .join("") || `<li class="pending">No runs yet.</li>`;
  return runs;
}

async function openRun(id) {
  current?.source.close();
  const runs = await loadRuns();
  const meta = runs.find((r) => r.id === id);
  if (!meta) return showEmpty();

  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  current = { id, source, state: emptyState(), fromLink: Boolean(meta.url) };
  $("empty").hidden = true;
  $("run").hidden = false;
  $("run-name").textContent = meta.name;
  $("run-report").href = `/api/runs/${encodeURIComponent(id)}/report.md`;
  $("player").hidden = !meta.hasAudio;
  if (meta.hasAudio) audio.src = `/api/runs/${encodeURIComponent(id)}/audio`;
  else audio.removeAttribute("src");

  const run = current;
  source.onmessage = (msg) => {
    if (current !== run) return;
    const message = JSON.parse(msg.data);
    apply(run.state, message);
    scheduleRender();
    if (message.kind === "status") refreshMeta(run);
    if (message.kind === "status" && ["done", "failed"].includes(message.status)) {
      source.close();
      loadRuns();
    }
  };
  source.onerror = () => {
    if (["done", "failed"].includes(run.state.status)) source.close();
  };
  render();
}

// A YouTube run only learns its title and gets a recording once the download finishes.
async function refreshMeta(run) {
  const meta = (await loadRuns()).find((r) => r.id === run.id);
  if (!meta || current !== run) return;
  $("run-name").textContent = meta.name;
  if (meta.hasAudio && $("player").hidden) {
    $("player").hidden = false;
    audio.src = `/api/runs/${encodeURIComponent(run.id)}/audio`;
  }
}

function showEmpty() {
  current?.source.close();
  current = null;
  $("empty").hidden = false;
  $("run").hidden = true;
  audio.pause();
  loadRuns();
}

$("run-delete").addEventListener("click", async () => {
  if (!current) return;
  const { id } = current;
  if (!confirm(`Delete "${$("run-name").textContent}"? Its recording, Transcript, and report will be removed.`)) return;
  // Release the recording first, or Windows will not let the server remove it.
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    alert(body.error ?? `Could not delete this run (${res.status}).`);
    return openRun(id);
  }
  if (current?.id === id) location.hash = "";
  else loadRuns();
});

function route() {
  const id = new URLSearchParams(location.hash.slice(1)).get("run");
  if (id) openRun(id);
  else showEmpty();
}
window.addEventListener("hashchange", route);

/* ---------- upload ---------- */

function upload(file) {
  const box = $("upload");
  box.hidden = false;
  box.innerHTML = `<div>Uploading ${escape(file.name)}…</div><progress max="1" value="0"></progress>`;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/runs?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => e.lengthComputable && (box.querySelector("progress").value = e.loaded / e.total);
  xhr.onload = () => {
    const body = JSON.parse(xhr.responseText || "{}");
    if (xhr.status !== 201) {
      box.innerHTML = `<div class="error">${escape(body.error ?? `Upload failed (${xhr.status})`)}</div>`;
      return;
    }
    box.hidden = true;
    location.hash = `run=${encodeURIComponent(body.id)}`;
  };
  xhr.onerror = () => (box.innerHTML = `<div class="error">Upload failed.</div>`);
  xhr.send(file);
}

async function submitLink(url) {
  const box = $("upload");
  box.hidden = false;
  box.innerHTML = `<div>Adding ${escape(url)}…</div>`;
  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 201) {
      box.innerHTML = `<div class="error">${escape(body.error ?? `Could not add link (${res.status})`)}</div>`;
      return;
    }
    box.hidden = true;
    $("link-url").value = "";
    location.hash = `run=${encodeURIComponent(body.id)}`;
  } catch {
    box.innerHTML = `<div class="error">Could not add link.</div>`;
  }
}

$("link").addEventListener("submit", (e) => {
  e.preventDefault();
  submitLink($("link-url").value.trim());
});

// Pasting a YouTube link anywhere outside a text field starts a run, like dropping a file.
window.addEventListener("paste", (e) => {
  if (e.target.closest("input, textarea")) return;
  const text = e.clipboardData?.getData("text").trim() ?? "";
  if (/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(text)) {
    e.preventDefault();
    submitLink(text);
  }
});

$("file").addEventListener("change", (e) => {
  const [file] = e.target.files;
  if (file) upload(file);
  e.target.value = "";
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $("dropping").hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) ((dragDepth = 0), ($("dropping").hidden = true));
});
window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("dropping").hidden = true;
  const [file] = e.dataTransfer.files;
  if (file) upload(file);
});

route();
