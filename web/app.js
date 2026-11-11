"use strict";
/* ShotForge — editorial studio UI (vanilla JS, no build step).
 *
 * Flow (4-step stepper):
 *   01 Source      → upload / local path / URL; target clips; ratio
 *   02 Typography  → 12 caption presets with real WYSIWYG sample previews
 *                    (/api/preview/sample), position + scale sliders
 *   03 Processing  → SSE pipeline progress, percent + log window
 *   04 Export      → rendered clip tiles: video + score + reason + camera note,
 *                    per-tile re-render with the chosen typography
 *
 * Server contract is unchanged; all dynamic text goes through textContent.
 */

const $ = (sel) => document.querySelector(sel);

const PACK_NAMES = {
  "beast-pop": "Beast Pop",
  hormozi: "Hormozi",
  "karaoke-pop": "Karaoke",
  "tiktok-clean": "TikTok Clean",
  "neon-gaming": "Neon Gaming",
  "netflix-minimal": "Netflix Minimal",
  typewriter: "Typewriter",
  "emoji-pop": "Emoji Pop",
  "gradient-pop": "Gradient Pop",
  "pill-box": "Pill Box",
  cinematic: "Cinematic",
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
  pack: "beast-pop",
  positionPct: 22,
  scalePct: 1,
  ratio: "9:16",
  top: 6,
  source: "",
  jobId: null,
  result: null,
  running: false,
  jobDone: false,
};

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#theme-btn").textContent = theme === "light" ? "Dark Mode" : "Light Mode";
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
  document.querySelectorAll(".step-content").forEach((el, i) => {
    el.classList.toggle("active", i + 1 === n);
  });
  document.querySelectorAll(".step-tab").forEach((el, i) => {
    el.classList.remove("active", "completed");
    if (i + 1 === n) el.classList.add("active");
    if (i + 1 < n) el.classList.add("completed");
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
    state.source = $("#source-input").value.trim();
    if (!state.source) {
      showStepError("step1-error", "Give me a local video path, a YouTube URL, or upload a file first.");
      return;
    }
    hideError("step1-error");
    state.top = clampNum(Number($("#top-n").value), 1, 20, 6);
    state.ratio = $("#ratio").value;
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
  $("#terminal").innerHTML = "<div>&gt; System ready.</div>";
  $("#progress-fill").style.width = "0%";
  $("#progress-percent").textContent = "0%";
  $("#progress-text").textContent = "Initializing engine…";
  goToStep(1);
}

function showStepError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message;
  el.classList.remove("hidden");
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
      $("#source-input").value = data.path;
      state.source = data.path;
      uploadSurface.querySelector(".upload-title").textContent =
        `Selected: ${file.name} — continue to Typography`;
    }
  } catch {
    uploadSurface.querySelector(".upload-title").textContent = "Upload failed — try again";
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
  grid.innerHTML = "";
  for (const id of state.packs) {
    const option = document.createElement("div");
    option.className = "template-option" + (id === state.pack ? " selected" : "");
    option.dataset.pack = id;
    option.setAttribute("role", "button");
    option.tabIndex = 0;

    const img = document.createElement("img");
    img.alt = `${PACK_NAMES[id] ?? id} caption preview`;
    img.src = samplePreviewUrl(id);
    const name = document.createElement("span");
    name.className = "template-name";
    name.textContent = PACK_NAMES[id] ?? id;
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
  document.querySelectorAll(".template-option").forEach((el) => {
    el.classList.toggle("selected", el.dataset.pack === id);
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
  $("#terminal").innerHTML = "";
  logLine("Submitting job to the engine…");

  fetch("/api/rank", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: state.source,
      top: state.top,
      pack: state.pack,
      ratio: state.ratio,
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
  bar.innerHTML = "";
  for (const stage of STAGES) {
    const pill = document.createElement("span");
    pill.className = "stage-pill";
    pill.dataset.stage = stage;
    pill.textContent = stage;
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

function listenProgress(jobId) {
  const es = new EventSource(`/api/progress/${jobId}`);
  es.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.stage) markStage(data.stage);
    if (data.note) logLine(`${data.stage}: ${data.note}`);

    const percent = STAGE_PERCENT[data.stage] ?? 0;
    $("#progress-fill").style.width = `${percent}%`;
    $("#progress-percent").textContent = `${percent}%`;
    $("#progress-text").textContent =
      data.stage === "render" ? `Rendering clips (${data.note ?? ""})` : `${data.stage}…`;

    if (data.status === "done") {
      es.close();
      $("#progress-fill").style.width = "100%";
      $("#progress-percent").textContent = "100%";
      $("#progress-text").textContent = "Process complete.";
      state.running = false;
      state.jobDone = true;
      goToStep(3);
    }
    if (data.status === "error") {
      es.close();
      state.running = false;
      showStepError("step3-error", "The engine hit an error — check the log above and try again.");
    }
  };
}

function logLine(text) {
  const terminal = $("#terminal");
  const line = document.createElement("div");
  const arrow = document.createElement("span");
  arrow.className = "log-accent";
  arrow.textContent = "> ";
  line.appendChild(arrow);
  line.appendChild(document.createTextNode(text));
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Step 4 — export: rendered clip tiles                                */
/* ------------------------------------------------------------------ */

async function buildExport() {
  const res = await fetch(`/api/rank/${state.jobId}`);
  const result = await res.json();
  if (!result.clips) {
    showStepError("step3-error", "Ranking result not available yet.");
    return;
  }
  state.result = result;
  const grid = $("#output-grid");
  grid.innerHTML = "";

  for (const clip of result.clips) {
    const card = document.createElement("div");
    card.className = "output-card";

    const thumb = document.createElement("div");
    thumb.className = "output-thumb";
    if (clip.video) {
      const video = document.createElement("video");
      video.src = mediaUrl(clip.video);
      video.controls = true;
      video.preload = "metadata";
      thumb.appendChild(video);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "template-loading";
      placeholder.textContent = "Not rendered yet — press Re-render";
      thumb.appendChild(placeholder);
    }
    const scoreFlag = document.createElement("div");
    scoreFlag.className = "score-flag";
    scoreFlag.textContent = `${clip.score} / 100`;
    thumb.appendChild(scoreFlag);

    const body = document.createElement("div");
    body.className = "output-body";

    const hook = document.createElement("div");
    hook.className = "output-hook";
    hook.textContent = clip.hook || `(visual moment, ${clip.kind})`;
    body.appendChild(hook);

    const reason = document.createElement("div");
    reason.className = "output-reason";
    reason.textContent = clip.reason;
    body.appendChild(reason);

    if (clip.cameraNote) {
      const camera = document.createElement("div");
      camera.className = "output-camera";
      camera.textContent = `CAMERA — ${clip.cameraNote}`;
      body.appendChild(camera);
    }

    const judges = document.createElement("div");
    judges.className = "output-judges";
    judges.textContent = `#${clip.rank} · ${fmt(clip.start)}→${fmt(clip.end)} · ${clip.durationSec.toFixed(0)}s · ${clip.kind} · h${clip.heuristic} llm${clip.llm ?? "-"} vis${clip.vision ?? "-"}`;
    body.appendChild(judges);

    const meta = document.createElement("div");
    meta.className = "output-meta";

    const id = document.createElement("span");
    id.className = "clip-id";
    id.textContent = `Clip_${String(clip.rank).padStart(2, "0")}.mp4`;
    meta.appendChild(id);

    const actions = document.createElement("div");
    actions.className = "output-actions";

    if (clip.video) {
      const save = document.createElement("a");
      save.className = "btn-download";
      save.href = mediaUrl(clip.video);
      save.download = `Clip_${String(clip.rank).padStart(2, "0")}.mp4`;
      save.textContent = "Save";
      actions.appendChild(save);
    }

    const rerender = document.createElement("button");
    rerender.className = "btn-download";
    rerender.type = "button";
    rerender.textContent = "Re-render";
    rerender.addEventListener("click", () => reRenderClip(clip, card));
    actions.appendChild(rerender);

    meta.appendChild(actions);
    card.append(thumb, body, meta);
    grid.appendChild(card);
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
        ratio: state.ratio,
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
      } else {
        await buildExport();
      }
    }
    button.textContent = "Re-render";
  } catch (err) {
    button.textContent = "Re-render";
    logLine(`re-render failed: ${err.message}`);
  }
  button.disabled = false;
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
