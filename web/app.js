"use strict";
/* ShotForge studio UI (vanilla JS, no build step).
 *
 * Flow (4-step stepper):
 *   01 Source      file upload (picker or drag & drop), target clips, caption
 *                  language.
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
  impact: "Impact",
  rainbow: "Rainbow",
  karaoke: "Karaoke",
  emoji: "Emoji Pop",
  marker: "Marker",
  glow: "Glow",
  box: "Box",
  editorial: "Editorial",
  typewriter: "Typewriter",
  fancy: "Fancy",
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
  const changed = state.step !== n;
  state.step = n;
  let activePanel = null;
  document.querySelectorAll(".step-content").forEach((elx, i) => {
    const active = i + 1 === n;
    elx.classList.toggle("active", active);
    if (active) {
      elx.tabIndex = -1; // programmatic focus target after transitions
      activePanel = elx;
    }
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
    // running → disabled status label; done → forward; stopped → recovery
    next.textContent = state.jobDone ? "View Results" : (state.running ? "Processing…" : "Try Again");
    next.disabled = state.running;
  } else {
    next.textContent = "Start New Project";
    next.disabled = false;
  }

  // Land keyboard and screen-reader focus inside the new step. Same-step
  // refreshes (SSE progress updates) never steal focus.
  if (changed && activePanel) activePanel.focus();
}

let lastNavClick = 0;

$("#btn-back").addEventListener("click", () => {
  const now = Date.now();
  if (now - lastNavClick < 400) return; // double-fire guard
  lastNavClick = now;
  if (state.step > 1 && !state.running) goToStep(state.step - 1);
});

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
    const rawTop = $("#top-n").value.trim();
    state.top = clampNum(rawTop === "" ? NaN : Number(rawTop), 1, 20, 6);
    state.translate = $("#caption-lang").value;
    goToStep(2);
  } else if (state.step === 2) {
    startJob();
  } else if (state.step === 3) {
    if (state.jobDone) {
      buildExport();
      goToStep(4);
    } else {
      goToStep(2); // processing stopped with an error — recover via Typography
    }
  } else if (state.step === 4) {
    resetProject();
  }
});

function resetProject() {
  state.jobId = null;
  state.result = null;
  state.running = false;
  state.jobDone = false;
  if (progressES) { progressES.close(); progressES = null; }
  // Deliberate: source and typography choices are kept so a project can be
  // re-run quickly; the upload title still shows the retained source.
  const terminal = $("#terminal");
  terminal.replaceChildren();
  logLine("System ready.");
  setProgress(0, "Initializing engine…");
  const note = $("#translate-note");
  note.hidden = true;
  note.textContent = "";
  hideError("step1-error");
  hideError("step3-error");
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
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault(); // role=button: Space must not scroll the page
    $("#file-input").click();
  }
});

$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // so re-picking the same file fires change again
  if (!file) return;
  await uploadAndUse(file);
});

function looksLikeVideo(file) {
  return file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name);
}

let uploadSeq = 0; // token: only the newest pick may update the UI / state
async function uploadAndUse(file) {
  const seq = ++uploadSeq;
  const title = uploadSurface.querySelector(".upload-title");
  if (!looksLikeVideo(file)) {
    title.textContent = `"${file.name}" is not a video file — use MP4, MOV or WEBM.`;
    return;
  }
  title.textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    });
    const data = await res.json();
    if (seq !== uploadSeq) return; // superseded by a newer selection
    if (data.path) {
      state.source = data.path;
      hideError("step1-error");
      title.textContent = `Selected: ${file.name}. Continue to Typography.`;
    } else {
      title.textContent =
        `Upload failed${data.error ? ` — ${data.error}` : ""}. Pick "${file.name}" again or drop it here.`;
    }
  } catch {
    if (seq !== uploadSeq) return;
    title.textContent = `Upload failed — the server did not answer. Pick "${file.name}" again or drop it here.`;
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
  if (state.running) return; // a job owns the pipeline; ignore drops meanwhile
  const files = Array.from(e.dataTransfer?.files ?? []);
  const file = files.find(looksLikeVideo);
  if (!file) {
    goToStep(1);
    uploadSurface.querySelector(".upload-title").textContent = files.length
      ? `"${files[0].name}" is not a video file — use MP4, MOV or WEBM.`
      : "Nothing usable was dropped — use a video file (MP4, MOV or WEBM).";
    return;
  }
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
    img.src = samplePreviewUrl(id, true);
    img.addEventListener("error", () => {
      img.replaceWith(el("div", "template-preview-fallback", "no preview"));
    });
    const name = el("span", "template-name", PACK_NAMES[id] ?? id);
    option.append(img, name);

    option.addEventListener("click", () => selectPack(id));
    option.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // role=button: Space must not scroll the page
        selectPack(id);
      }
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

function samplePreviewUrl(pack, band) {
  const params = new URLSearchParams({
    pack,
    position: String(state.positionPct),
    scale: String(state.scalePct),
    v: "2", // cache-buster: v1 entries were full-frame crops at 78% position
  });
  if (band) params.set("band", "1");
  return `/api/preview/sample?${params.toString()}`;
}

function refreshBigPreview() {
  $("#preview-img").src = samplePreviewUrl(state.pack);
}

/* Big preview: if the sample render fails, show a fallback plate instead of
   a broken image; restore the image as soon as a render succeeds again. */
(function watchBigPreview() {
  const img = $("#preview-img");
  img.addEventListener("error", () => {
    img.style.display = "none";
    const canvas = img.parentElement;
    if (canvas && !canvas.querySelector(".preview-fallback")) {
      const plate = el("div", "preview-fallback",
        "Preview unavailable — check that the engine server is running.");
      plate.style.cssText =
        "position:absolute;inset:0;display:grid;place-items:center;padding:16px;" +
        "font-family:var(--font-mono);font-size:12px;color:var(--color-smoke);text-align:center;";
      canvas.appendChild(plate);
    }
  });
  img.addEventListener("load", () => {
    img.parentElement?.querySelector(".preview-fallback")?.remove();
    img.style.display = "";
  });
})();

let previewTimer = null;
function debouncedPreviewRefresh() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    refreshBigPreview();
    for (const option of document.querySelectorAll(".template-option")) {
      const img = option.querySelector("img");
      if (img) img.src = samplePreviewUrl(option.dataset.pack, true);
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
  hideError("step3-error");
  if (progressES) { progressES.close(); progressES = null; } // drop any stale stream
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
      showStepError("step3-error",
        `Could not start the job: ${err.message}. Check that the engine server is running, then press Start Processing again.`);
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

let progressES = null;
let lastPercent = 0;

function listenProgress(jobId, attempt = 0) {
  if (progressES) progressES.close();
  lastPercent = 0;
  const es = new EventSource(`/api/progress/${jobId}`);
  progressES = es;
  es.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.stage) markStage(data.stage);
    if (data.note) logLine(`${data.stage}: ${data.note}`);

    // Hold the last known percent on an unknown stage instead of regressing to 0.
    if (data.stage in STAGE_PERCENT) lastPercent = STAGE_PERCENT[data.stage];
    // Sub-stage notes ("text 3/24", "camera 2/6") interpolate the bar between
    // the stage's own percent and the next stage's.
    let percent = lastPercent;
    const sub = (data.note ?? "").match(/\b(\d+)\/(\d+)$/);
    if (sub && data.stage in STAGE_PERCENT) {
      const order = STAGES.indexOf(data.stage);
      const next = STAGES.slice(order + 1).find((s) => s in STAGE_PERCENT);
      const span = (next ? STAGE_PERCENT[next] : 100) - STAGE_PERCENT[data.stage];
      percent = STAGE_PERCENT[data.stage] + span * (Number(sub[1]) / Number(sub[2]));
      percent = Math.round(percent * 10) / 10;
    }
    setProgress(
      percent,
      data.stage === "render" ? `Rendering clips (${data.note ?? ""})` : `${data.stage} ${data.note ?? ""}…`.replace(" …", "…"),
    );

    if (data.status === "done") {
      es.close();
      if (progressES === es) progressES = null;
      setProgress(100, "Process complete.");
      state.running = false;
      state.jobDone = true;
      goToStep(3);
    }
    if (data.status === "error") {
      es.close();
      if (progressES === es) progressES = null;
      jobFailed(jobId, data.error ?? "the engine reported an error");
    }
  };
  es.onerror = () => {
    if (progressES === es) progressES = null;
    if (!state.running) { es.close(); return; }
    if (es.readyState === EventSource.CLOSED) {
      // Terminal drop (e.g. the server restarted) — find out what survived.
      probeJobAfterDrop(jobId, attempt);
    } else {
      // Transient drop — EventSource retries on its own; say so instead of
      // leaving the UI silently stuck on the last stage.
      setProgress(lastPercent, "Connection lost — retrying…");
    }
  };
}

/* After the SSE stream died for good, ask the server what happened to the
   job: finished while we were away, failed, still running (reattach), or
   gone (server restarted and lost the job). */
async function probeJobAfterDrop(jobId, attempt) {
  try {
    const res = await fetch(`/api/rank/${jobId}`);
    const data = await res.json();
    if (state.jobId !== jobId || !state.running) return; // a newer job took over
    if (Array.isArray(data?.clips)) {
      state.running = false;
      state.jobDone = true;
      setProgress(100, "Process complete.");
      goToStep(3);
      return;
    }
    if (data?.status === "error") {
      jobFailed(jobId, data.error ?? "the engine reported an error");
      return;
    }
    if (data?.error === "unknown job") {
      // The server came back up without this job — it was restarted mid-run.
      jobFailed(jobId, "the engine server restarted and this job was lost");
      return;
    }
    if (attempt < 3) {
      listenProgress(jobId, attempt + 1); // job still alive — reattach
      return;
    }
    jobFailed(jobId, "the progress stream kept dropping");
  } catch {
    if (state.jobId !== jobId || !state.running) return;
    jobFailed(jobId, "lost contact with the engine server (it may have restarted)");
  }
}

function jobFailed(jobId, detail) {
  if (state.jobId !== jobId) return; // stale event from an older job
  state.running = false;
  state.jobDone = false;
  showStepError("step3-error",
    `Processing stopped — ${detail}. Press Try Again to return to Typography and start a new run.`);
  goToStep(3);
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

let exportSeq = 0; // token: only the newest build may touch the grid
async function buildExport() {
  const seq = ++exportSeq;
  const grid = $("#output-grid");
  renderGridState(grid, "loading", "Loading rendered clips…");

  let result;
  try {
    const res = await fetch(`/api/rank/${state.jobId}`);
    result = await res.json();
  } catch (err) {
    if (seq !== exportSeq) return;
    renderGridState(grid, "error",
      `Could not load results: ${err.message}. Press Retry — if it keeps failing, check the engine server.`,
      "Retry", buildExport);
    return;
  }
  if (seq !== exportSeq) return;
  if (!result || result.error || !Array.isArray(result.clips)) {
    renderGridState(grid, "error",
      `${result?.error ?? "Ranking result not available."} Press Retry, or start a new project.`,
      "Retry", buildExport);
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
    const expand = el("button", "expand-flag", "Expand");
    expand.type = "button";
    expand.setAttribute("aria-label", `Watch clip ${clip.rank} full size`);
    expand.addEventListener("click", () =>
      openVideoModal(mediaUrl(clip.video), clip.thumb ?? null));
    media.appendChild(expand);
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
  rerender.title = "Rebuilds this clip with your current typography (preset, position, scale)"
    + " — use after changing step-2 settings, or if this tile shows “Render failed”.";
  rerender.addEventListener("click", () => reRenderClip(clip, card));
  actions.appendChild(rerender);
  body.appendChild(actions);

  card.append(media, body);
  return card;
}

/* Full-size clip viewer: overlay with a large player. Backdrop click / Esc closes. */
function openVideoModal(src, poster) {
  closeModal();
  const overlay = el("div", "video-modal");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Clip preview, full size");
  const video = document.createElement("video");
  video.src = src;
  if (poster) video.poster = poster;
  video.controls = true;
  video.autoplay = true;
  overlay.appendChild(video);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.body.appendChild(overlay);
  document.body.classList.add("modal-open");
  video.focus();
}

function closeModal() {
  const overlay = document.querySelector(".video-modal");
  if (!overlay) return;
  const video = overlay.querySelector("video");
  if (video) video.pause();
  overlay.remove();
  document.body.classList.remove("modal-open");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

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

let copyFlash = { button: null, timer: null };

function resetCopyButton(button) {
  button.textContent = "Copy all";
  button.classList.remove("copied");
}

async function copyText(text, button) {
  if (copyFlash.timer) {
    // A previous copy button is still flashing — restore it before this one.
    clearTimeout(copyFlash.timer);
    resetCopyButton(copyFlash.button);
    copyFlash.timer = null;
    copyFlash.button = null;
  }
  const flash = (msg, copied) => {
    button.textContent = msg;
    if (!copied) button.title = "Clipboard blocked — select the hashtags and copy them manually.";
    button.classList.toggle("copied", copied);
    copyFlash.button = button;
    copyFlash.timer = setTimeout(() => {
      resetCopyButton(button);
      button.title = "";
      copyFlash.timer = null;
      copyFlash.button = null;
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
    if (!out) throw new Error("the engine returned no output for this clip");
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
  } catch (err) {
    // The log window lives on step 3; surface the failure here instead.
    button.textContent = "Render failed";
    button.title = `${err.message} — press Re-render to try again.`;
    setTimeout(() => {
      button.textContent = "Re-render";
      button.title = "";
    }, 2500);
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
goToStep(1); // initial paint: step unchanged, so focus is not stolen from the page
