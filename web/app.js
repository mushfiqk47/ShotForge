"use strict";
/* ShotForge studio UI (vanilla JS, no build step).
 *
 * Flow (4-step stepper):
 *   01 Source      upload / local path / URL, target clips, caption language.
 *                  Output is always vertical 9:16 (1080x1920), shown as a
 *                  static readout, not a control.
 *   02 Typography  11 caption presets with real WYSIWYG sample previews
 *                  (/api/preview/sample), position + scale sliders
 *   03 Processing  SSE pipeline progress, percent + log window; shows the
 *                  active caption translation when one is selected
 *   04 Export      rendered clip tiles: video + QC badge + social metadata
 *                  (title, hashtags, description) + score + reason + camera
 *                  note, per-tile re-render with the chosen typography
 *
 * Server contract: /api/rank {source, top, translate, pack, positionPct,
 * scalePct, autoRender}; /api/render {jobId, indexes, pack, positionPct,
 * scalePct} (renders are always 9:16 server-side). All dynamic text goes
 * through textContent / createElement.
 */

const $ = (sel) => document.querySelector(sel);

const PACK_NAMES = {
  classic: "Classic",
  highlight: "Highlight",
  "yellow-pop": "Yellow Pop",
  karaoke: "Karaoke",
  box: "Box",
  minimal: "Minimal",
  typewriter: "Typewriter",
  glow: "Glow",
  fancy: "Fancy",
  hormozi: "Hormozi",
  "nastaliq-urdu": "Urdu Nastaliq",
};

const STAGES = [
  "ingest", "audio", "transcribe", "detect", "candidates",
  "llm", "ensemble", "omni", "render", "done",
];

/* Stage → rough percent for the progress bar (real note overrides the label). */
const STAGE_PERCENT = {
  ingest: 4, audio: 12, transcribe: 35, detect: 48, candidates: 58,
  llm: 74, ensemble: 80, omni: 90, render: 96, done: 100,
};

const state = {
  step: 1,
  packs: [],
  pack: "highlight",
  positionPct: 22,
  scalePct: 1,
  translate: "none",
  top: 6,
  source: "",
  jobId: null,
  result: null,
  running: false,
  jobDone: false,
};

/* ------------------------------------------------------------------ */
/* Small DOM helper (keeps every dynamic string out of innerHTML)      */
/* ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#theme-btn").setAttribute(
    "aria-label",
    theme === "light" ? "Switch to dark mode" : "Switch to light mode",
  );
  try { localStorage.setItem("shotforge-theme", theme); } catch {}
}

$("#theme-btn").addEventListener("click", () => {
  const next =
    document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(next);
});
applyTheme((() => {
  try { return localStorage.getItem("shotforge-theme") || "light"; } catch { return "light"; }
})());

/* ------------------------------------------------------------------ */
/* Stepper                                                             */
/* ------------------------------------------------------------------ */

function goToStep(n) {
  state.step = n;
  document.querySelectorAll(".step-content").forEach((elx, i) => {
    elx.classList.toggle("active", i + 1 === n);
  });
  document.querySelectorAll(".step-tab").forEach((elx, i) => {
    elx.classList.remove("active", "completed");
    if (i + 1 === n) elx.classList.add("active");
    if (i + 1 < n) elx.classList.add("completed");
  });

  const back = $("#btn-back");
  const next = $("#btn-next");
  back.style.display = n === 1 || n === 3 ? "none" : "inline-block";

  if (n === 1) {
    next.textContent = "Continue";
    next.disabled = false;
  } else if (n === 2) {
    next.textContent = "Start Processing";
    next.disabled = state.running;
  } else if (n === 3) {
    next.textContent = state.jobDone ? "View Results" : "Processing…";
    next.disabled = !state.jobDone;
  } else {
    next.textContent = "Start New Project";
    next.disabled = false;
  }
}

$("#btn-back").addEventListener("click", () => {
  if (state.step > 1 && !state.running) goToStep(state.step - 1);
});

let lastNavClick = 0;
$("#btn-next").addEventListener("click", () => {
  const now = Date.now();
  if (now - lastNavClick < 400) return; // double-fire guard
  lastNavClick = now;
  if (state.running) return;
  if (state.step === 1) {
    state.source = (state.source ?? "").trim();
    if (!state.source) {
      showStepError("step1-error", "Upload a video file first — click the surface or drop the file anywhere.");
      return;
    }
    hideError("step1-error");
    state.top = clampNum(Number($("#top-n").value), 1, 20, 6);
    state.translate = $("#caption-lang").value;
    goToStep(2);
  } else if (state.step === 2) {
    startJob();
  } else if (state.step === 3 && state.jobDone) {
    buildExport();
    goToStep(4);
  } else if (state.step === 4) {
    resetProject();
  }
});

function resetProject() {
  state.jobId = null;
  state.result = null;
  state.running = false;
  state.jobDone = false;
  const terminal = $("#terminal");
  terminal.replaceChildren();
  logLine("System ready.");
  setProgress(0, "Initializing engine…");
  const note = $("#translate-note");
  note.hidden = true;
  note.textContent = "";
  goToStep(1);
}

function showStepError(id, message) {
  const elx = document.getElementById(id);
  elx.textContent = message;
  elx.classList.remove("hidden");
}
function hideError(id) {
  document.getElementById(id).classList.add("hidden");
}

/* ------------------------------------------------------------------ */
/* Step 1 — source: upload + drag & drop                               */
/* ------------------------------------------------------------------ */

const uploadSurface = $("#upload-surface");
uploadSurface.addEventListener("click", () => $("#file-input").click());
uploadSurface.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") $("#file-input").click();
});

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await uploadAndUse(file);
});

async function uploadAndUse(file) {
  uploadSurface.querySelector(".upload-title").textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    });
    const data = await res.json();
    if (data.path) {
      state.source = data.path;
      uploadSurface.querySelector(".upload-title").textContent =
        `Selected: ${file.name}. Continue to Typography.`;
    } else {
      uploadSurface.querySelector(".upload-title").textContent = "Upload failed, try again";
    }
  } catch {
    uploadSurface.querySelector(".upload-title").textContent = "Upload failed, try again";
  }
}

/* Drag & drop (full window) */
const overlay = $("#drop-overlay");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth += 1;
  overlay.classList.remove("hidden");
});
window.addEventListener("dragleave", (e) => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.classList.add("hidden");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.add("hidden");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  goToStep(1);
  await uploadAndUse(file);
});

/* ------------------------------------------------------------------ */
/* Step 2 — typography: packs, sample previews, sliders                */
/* ------------------------------------------------------------------ */

async function loadPacks() {
  const grid = $("#template-grid");
  try {
    const res = await fetch("/api/packs");
    const data = await res.json();
    state.packs = data.packs.map((p) => p.id);
  } catch {
    state.packs = Object.keys(PACK_NAMES);
  }
  grid.replaceChildren();
  for (const id of state.packs) {
    const option = el("div", "template-option" + (id === state.pack ? " selected" : ""));
    option.dataset.pack = id;
    option.setAttribute("role", "button");
    option.tabIndex = 0;
    option.setAttribute("aria-pressed", String(id === state.pack));

    const img = document.createElement("img");
    img.alt = `${PACK_NAMES[id] ?? id} caption preview`;
    img.src = samplePreviewUrl(id);
    img.addEventListener("error", () => {
      img.replaceWith(el("div", "template-preview-fallback", "no preview"));
    });
    const name = el("span", "template-name", PACK_NAMES[id] ?? id);
    option.append(img, name);

    option.addEventListener("click", () => selectPack(id));
    option.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") selectPack(id);
    });
    grid.appendChild(option);
  }
}

function selectPack(id) {
  state.pack = id;
  document.querySelectorAll(".template-option").forEach((opt) => {
    const selected = opt.dataset.pack === id;
    opt.classList.toggle("selected", selected);
    opt.setAttribute("aria-pressed", String(selected));
  });
  refreshBigPreview();
}

function samplePreviewUrl(pack) {
  const params = new URLSearchParams({
    pack,
    position: String(state.positionPct),
    scale: String(state.scalePct),
  });
  return `/api/preview/sample?${params.toString()}`;
}

function refreshBigPreview() {
  $("#preview-img").src = samplePreviewUrl(state.pack);
}

let previewTimer = null;
function debouncedPreviewRefresh() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    refreshBigPreview();
    for (const option of document.querySelectorAll(".template-option")) {
      const img = option.querySelector("img");
      if (img) img.src = samplePreviewUrl(option.dataset.pack);
    }
  }, 350);
}

$("#caption-pos").addEventListener("input", (e) => {
  state.positionPct = clampNum(Number(e.target.value), 5, 60, 22);
  $("#pos-val").textContent = `${state.positionPct}%`;
  debouncedPreviewRefresh();
});

$("#caption-size").addEventListener("input", (e) => {
  const pct = clampNum(Number(e.target.value), 60, 160, 100);
  state.scalePct = pct / 100;
  $("#size-val").textContent = `${(pct / 100).toFixed(2)}x`;
  debouncedPreviewRefresh();
});

/* ------------------------------------------------------------------ */
/* Step 3 — processing: rank job + SSE                                 */
/* ------------------------------------------------------------------ */

function startJob() {
  state.running = true;
  state.jobDone = false;
  goToStep(3);
  buildStagePills();

  const note = $("#translate-note");
  if (state.translate === "none") {
    note.hidden = true;
    note.textContent = "";
  } else {
    note.textContent = `captions → ${state.translate}`;
    note.hidden = false;
  }

  $("#terminal").replaceChildren();
  logLine("Submitting job to the engine…");

  fetch("/api/rank", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: state.source,
      top: state.top,
      translate: state.translate,
      pack: state.pack,
      positionPct: state.positionPct,
      scalePct: state.scalePct,
      autoRender: true,
    }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.error) throw new Error(data.error);
      state.jobId = data.jobId;
      listenProgress(data.jobId);
    })
    .catch((err) => {
      state.running = false;
      showStepError("step3-error", `Failed to start: ${err.message}`);
      goToStep(2);
    });
}

function buildStagePills() {
  const bar = $("#stage-pills");
  bar.replaceChildren();
  for (const stage of STAGES) {
    const pill = el("span", "stage-pill", stage);
    pill.dataset.stage = stage;
    bar.appendChild(pill);
  }
}

function markStage(stage) {
  const activeIdx = STAGES.indexOf(stage);
  for (const pill of $("#stage-pills").children) {
    const idx = STAGES.indexOf(pill.dataset.stage);
    pill.classList.toggle("active", idx === activeIdx);
    pill.classList.toggle("done", activeIdx > idx);
  }
}

function setProgress(pct, statusText) {
  $("#progress-fill").style.width = `${pct}%`;
  $("#progress-percent").textContent = `${pct}%`;
  $("#progress-track").setAttribute("aria-valuenow", String(pct));
  if (statusText) $("#progress-text").textContent = statusText;
}

function listenProgress(jobId) {
  const es = new EventSource(`/api/progress/${jobId}`);
  es.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.stage) markStage(data.stage);
    if (data.note) logLine(`${data.stage}: ${data.note}`);

    const percent = STAGE_PERCENT[data.stage] ?? 0;
    setProgress(
      percent,
      data.stage === "render" ? `Rendering clips (${data.note ?? ""})` : `${data.stage}…`,
    );

    if (data.status === "done") {
      es.close();
      setProgress(100, "Process complete.");
      state.running = false;
      state.jobDone = true;
      goToStep(3);
    }
    if (data.status === "error") {
      es.close();
      state.running = false;
      showStepError("step3-error", "The engine hit an error. Check the log above and try again.");
    }
  };
}

function logLine(text) {
  const terminal = $("#terminal");
  const line = document.createElement("div");
  const arrow = el("span", "log-accent", "> ");
  line.appendChild(arrow);
  line.appendChild(document.createTextNode(text));
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Step 4 — export: rendered clip tiles                                */
/* ------------------------------------------------------------------ */

async function buildExport() {
  const grid = $("#output-grid");
  renderGridState(grid, "loading", "Loading rendered clips…");

  let result;
  try {
    const res = await fetch(`/api/rank/${state.jobId}`);
    result = await res.json();
  } catch (err) {
    renderGridState(grid, "error", `Could not load results: ${err.message}`, "Retry", buildExport);
    return;
  }
  if (!result || result.error || !Array.isArray(result.clips)) {
    renderGridState(grid, "error", result?.error ?? "Ranking result not available.", "Retry", buildExport);
    return;
  }
  if (result.clips.length === 0) {
    renderGridState(grid, "empty",
      "The engine returned no clips for this source. Try different footage or raise the target clip count.");
    return;
  }

  state.result = result;
  grid.replaceChildren();
  for (const clip of result.clips) {
    grid.appendChild(buildClipCard(clip));
  }
}

function renderGridState(grid, kind, message, retryLabel, onRetry) {
  grid.replaceChildren();
  const box = el("div", "output-state" + (kind === "error" ? " output-state-error" : ""));
  box.appendChild(el("p", "output-state-text", message));
  if (onRetry) {
    const retry = el("button", "btn-download", retryLabel);
    retry.type = "button";
    retry.addEventListener("click", onRetry);
    box.appendChild(retry);
  }
  grid.appendChild(box);
}

function buildClipCard(clip) {
  const card = el("div", "output-card");

  /* Media column: video (poster while it loads), poster-only, or placeholder. */
  const media = el("div", "output-media");
  if (clip.video) {
    const video = document.createElement("video");
    video.src = mediaUrl(clip.video);
    video.controls = true;
    video.preload = "metadata";
    if (clip.thumb) video.poster = clip.thumb;
    media.appendChild(video);
  } else if (clip.thumb) {
    const poster = document.createElement("img");
    poster.src = clip.thumb;
    poster.alt = `Clip ${clip.rank} poster`;
    media.appendChild(poster);
  } else {
    media.appendChild(el("div", "output-placeholder",
      "Not rendered yet. Press Re-render to render it with the current typography."));
  }
  media.appendChild(el("div", "score-flag", `${clip.score ?? 0} / 100`));

  /* Body column. */
  const body = el("div", "output-body");
  const meta = clip.meta ?? null;

  const topline = el("div", "output-topline");
  topline.appendChild(el("span", "clip-id", `Clip_${String(clip.rank).padStart(2, "0")}.mp4`));
  const qc = qcBadge(clip.checks);
  if (qc) topline.appendChild(qc);
  body.appendChild(topline);

  /* Title: social metadata when present, hook as the fallback. */
  const titleText = (meta && meta.title) || clip.hook || `(visual moment, ${clip.kind})`;
  body.appendChild(el("h3", "clip-title", titleText));

  /* Keep the spoken hook visible when the title came from metadata. */
  if (meta && meta.title && clip.hook) {
    body.appendChild(el("div", "output-hook", `Hook · ${clip.hook}`));
  }

  if (clip.reason) body.appendChild(el("p", "output-reason", clip.reason));

  if (meta && Array.isArray(meta.hashtags) && meta.hashtags.length) {
    body.appendChild(buildHashtagRow(meta.hashtags));
  }
  if (meta && meta.description) {
    body.appendChild(el("p", "output-desc", meta.description));
  }

  if (clip.cameraNote) {
    body.appendChild(el("div", "output-camera", `CAMERA · ${clip.cameraNote}`));
  }

  body.appendChild(el("div", "output-judges", judgesLine(clip)));

  const actions = el("div", "output-actions");
  if (clip.video) {
    const save = document.createElement("a");
    save.className = "btn-download";
    save.href = mediaUrl(clip.video);
    save.download = `Clip_${String(clip.rank).padStart(2, "0")}.mp4`;
    save.textContent = "Save";
    actions.appendChild(save);
  }
  const rerender = el("button", "btn-download", "Re-render");
  rerender.type = "button";
  rerender.addEventListener("click", () => reRenderClip(clip, card));
  actions.appendChild(rerender);
  body.appendChild(actions);

  card.append(media, body);
  return card;
}

function buildHashtagRow(hashtags) {
  const row = el("div", "hashtags-row");
  for (const tag of hashtags) {
    row.appendChild(el("span", "tag-chip", tag));
  }
  const copy = el("button", "tag-copy", "Copy all");
  copy.type = "button";
  copy.setAttribute("aria-live", "polite");
  copy.addEventListener("click", () => copyText(hashtags.join(" "), copy));
  row.appendChild(copy);
  return row;
}

let copyResetTimer = null;
async function copyText(text, button) {
  const flash = (msg, copied) => {
    button.textContent = msg;
    button.classList.toggle("copied", copied);
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      button.textContent = "Copy all";
      button.classList.remove("copied");
    }, 1500);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      flash("Copied", true);
      return;
    }
  } catch { /* fall through to the legacy path */ }
  let area = null;
  try {
    area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    flash(ok ? "Copied" : "Copy failed", ok);
  } catch {
    flash("Copy failed", false);
  } finally {
    if (area) area.remove();
  }
}

function qcBadge(checks) {
  if (!checks) return null; // QC lands progressively; no checks means no badge
  const pass = checks.pass === true;
  const badge = el("span", "qc-badge" + (pass ? "" : " qc-fail"), pass ? "QC PASS" : "QC FAIL");
  if (!pass && Array.isArray(checks.problems) && checks.problems.length) {
    badge.title = checks.problems.join(" · ");
  }
  return badge;
}

function updateQcBadge(card, checks) {
  const topline = card.querySelector(".output-topline");
  if (!topline) return;
  const old = topline.querySelector(".qc-badge");
  const fresh = qcBadge(checks);
  if (fresh) {
    if (old) old.replaceWith(fresh); else topline.appendChild(fresh);
  } else if (old) {
    old.remove();
  }
}

async function reRenderClip(clip, card) {
  const button = card.querySelector(".output-actions button");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Rendering…";
  try {
    const res = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: state.jobId,
        indexes: [clip.rank],
        pack: state.pack,
        positionPct: state.positionPct,
        scalePct: state.scalePct,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const out = data.outputs?.[0];
    if (out) {
      const video = card.querySelector("video");
      if (video) {
        video.src = `${out.url || mediaUrl(out.file)}?v=${Date.now()}`;
        video.load();
        updateQcBadge(card, out.checks);
        button.textContent = "Re-render";
      } else {
        await buildExport(); // full rebuild picks up the newly rendered file
        return;
      }
    }
  } catch (err) {
    button.textContent = "Failed";
    setTimeout(() => { button.textContent = "Re-render"; }, 2000);
    logLine(`re-render failed: ${err.message}`);
  }
  button.disabled = false;
}

function judgesLine(clip) {
  const llm = clip.llm ?? "-";
  const vis = clip.vision ?? "-";
  const secs = Math.round(clip.durationSec ?? 0);
  return `#${clip.rank} · ${fmt(clip.start)}→${fmt(clip.end)} · ${secs}s · ${clip.kind} · h${clip.heuristic} llm${llm} vis${vis}`;
}

function mediaUrl(serverPath) {
  if (serverPath.startsWith("/media/")) return serverPath;
  const base = serverPath.split(/[\\/]/).pop();
  return `/media/${state.result?.workId ?? ""}/${base}`;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function clampNum(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

loadPacks();
goToStep(1);
