/**
 * ShotForge ranking engine — shared by the CLI and the web server.
 * ingest → audio(+energy) → whisper CUDA → shot detect → candidates (speech ∪
 * visual) → heuristic pre-score → lfm3 re-rank → lfm3-vl frames → ensemble →
 * omni analysis → cut snap → caption translate → render (+ checks) →
 * metadata + thumbnails.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

import { PATHS, verifyPaths } from "../paths.js";
import { unloadModel } from "../ollama.js";
import { ingest } from "./ingest.js";
import { extractAudio, energyCurve } from "./audio.js";
import { transcribe } from "./transcribe.js";
import { detectShots, shotsFromCuts } from "./detect.js";
import { speechCandidates, visualCandidates } from "./candidates.js";
import { heuristicScore } from "./score-heuristic.js";
import { llmScore } from "./score-llm.js";
import { ensemble } from "./ensemble.js";
import { analyzeClips, applyOmniAdjustments } from "./omni.js";
import { renderClip } from "./render.js";
import { translateWords } from "./translate.js";
import { generateMetadata } from "./metadata.js";
import { renderThumbnail } from "./thumb.js";

export const STAGES = [
  "ingest",
  "audio",
  "transcribe",
  "detect",
  "candidates",
  "llm",
  "ensemble",
  "omni",
  "render",
  "done",
];

/** Resolve URLs through the bundled yt-dlp. Returns an absolute local path. */
export function resolveSource(input, { downloadsDir } = {}) {
  const absolute = resolve(input);
  if (!/^https?:\/\//i.test(input)) return absolute;
  const target = downloadsDir ?? resolve("downloads");
  mkdirSync(target, { recursive: true });
  const result = spawnSync(
    PATHS.ytdlp,
    [
      "-f", "bv*[height<=1080]+ba/b[height<=1080]",
      "-o", `${join(target, "%(title).80s.%(ext)s")}`,
      input,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 3_600_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `yt-dlp failed: ${(result.stderr ?? "").split("\n").slice(-6).join(" | ")}`,
    );
  }
  const out = `${result.stdout ?? ""}`;
  const line = out
    .split("\n")
    .reverse()
    .find((l) => l.includes("has already been downloaded") || l.includes("Destination:"));
  const file = line ? line.split(/(?:Destination:|downloaded:)\s*/)[1]?.trim() : null;
  if (!file) throw new Error("yt-dlp ran but the output file name could not be resolved");
  return resolve(file);
}

/**
 * @param {object} opts
 * @param {string} opts.source          file path or http(s) URL
 * @param {string} opts.workRoot        root for .work dirs
 * @param {number} [opts.top=10]
 * @param {{pack?:string, positionPct?:number, scalePct?:number}} [opts.render]
 * @param {string} [opts.translate="none"]  caption translation mode (TRANSLATE_MODES)
 * @param {boolean} [opts.autoRender=true]  render every ranked clip after scoring
 * @param {(stage:string, note?:string)=>void} [opts.onStage]
 * @param {(line:string)=>void} [opts.log]
 */
export async function runRank({
  source,
  workRoot,
  top = 10,
  render: renderOpts = {},
  translate = "none",
  autoRender = true,
  onStage = () => {},
  log = () => {},
}) {
  const problems = verifyPaths();
  if (problems.length) throw new Error(`Missing dependencies:\n${problems.join("\n")}`);

  const timings = {};
  const t0 = Date.now();
  const ms = (from) => Date.now() - from;

  onStage("ingest");
  const videoPath = resolveSource(source, { downloadsDir: resolve(workRoot, "downloads") });
  const workDir = resolve(workRoot, ".work", Buffer.from(videoPath).toString("base64url").slice(-60));
  mkdirSync(workDir, { recursive: true });

  let t = Date.now();
  const probe = await ingest(videoPath, workDir);
  timings.ingest = ms(t);
  log(`${probe.width}x${probe.height} · ${probe.durationSec.toFixed(1)}s · audio=${probe.hasAudio}`);

  onStage("audio");
  t = Date.now();
  let energy = new Float32Array(Math.ceil(probe.durationSec));
  if (probe.hasAudio) {
    const { wavPath } = await extractAudio(videoPath, workDir);
    energy = energyCurve(wavPath);
  } else {
    log("silent source — visual-only mode");
  }
  timings.audio = ms(t);

  onStage("transcribe");
  t = Date.now();
  let transcript = { language: "none", segments: [], words: [] };
  if (probe.hasAudio) {
    transcript = await transcribe(resolve(workDir, "audio.wav"), workDir);
    log(`language=${transcript.language} · ${transcript.segments.length} segments · ${transcript.words.length} words`);
  }
  timings.transcribe = ms(t);

  onStage("detect");
  t = Date.now();
  const cuts = await detectShots(videoPath);
  const shots = shotsFromCuts(cuts, probe.durationSec);
  log(`${shots.length} shots`);
  timings.detect = ms(t);

  onStage("candidates");
  t = Date.now();
  const speech = speechCandidates(transcript.words, transcript.segments, energy, probe.durationSec);
  const visual = visualCandidates(shots, energy, probe.durationSec);
  const all = [...speech, ...visual];
  for (const c of all) c.heuristic = heuristicScore(c);
  log(`${speech.length} speech + ${visual.length} visual = ${all.length} candidates`);
  timings.candidates = ms(t);

  onStage("llm");
  t = Date.now();
  const shortlist = await llmScore(videoPath, workDir, all, log);
  timings.llm = ms(t);

  onStage("ensemble");
  t = Date.now();
  const ranked = ensemble(shortlist, { top });
  // Internal clips carry their final rank too (omni/snap/thumb logs and
  // thumb_<rank>.jpg naming all read clip.rank).
  for (let i = 0; i < ranked.length; i += 1) ranked[i].rank = i + 1;
  timings.ensemble = ms(t);

  onStage("omni");
  t = Date.now();
  await analyzeClips(videoPath, ranked, workDir, log);
  for (const c of ranked) applyOmniAdjustments(c);

  // Word-level caption timing for each clip (sliced by the FINAL window), then
  // snap cut points to scene boundaries without ever cutting mid-word.
  const absWords = transcriptWords(workDir);
  const wordsByClip = clipWords(absWords, ranked);
  snapCutsToShots(ranked, shots, absWords, wordsByClip, log);

  // Caption translation (ClipShlip headline feature): word-for-word map so
  // karaoke timings survive; sequential, before the render phase.
  if (translate && translate !== "none") {
    onStage("omni", `translating captions → ${translate}`);
    try {
      for (const clip of ranked) {
        const words = wordsByClip.get(clip);
        if (!words?.length) continue;
        wordsByClip.set(clip, await translateWords(words, translate, log));
      }
    } catch (err) {
      log(`translate: skipped (${err.message}) — captions stay in the original language`);
    }
    await unloadModel(PATHS.models.text);
  }
  timings.omni = ms(t);

  const result = {
    source: videoPath,
    workId: Buffer.from(videoPath).toString("base64url").slice(-60),
    durationSec: probe.durationSec,
    language: transcript.language,
    timingsSec: timings,
    totalWallSec: 0,
    clips: ranked.map((c, i) => ({
      rank: i + 1,
      score: c.score,
      start: c.finalStart,
      end: c.finalEnd,
      durationSec: c.durationSec,
      kind: c.kind,
      hook: c.hook,
      reason: c.reason,
      cameraNote: c.cameraNote ?? null,
      transcript: c.text ? c.text.slice(0, 600) : "",
      signals: c.signals,
      heuristic: Math.round((c.heuristic ?? 0) * 100),
      llm: c.llm?.score ?? null,
      vision: c.vision?.score ?? null,
      video: null,
      checks: null,
      meta: null,
      thumb: null,
    })),
  };

  if (autoRender) {
    onStage("render");
    t = Date.now();
    // Renders are always vertical 9:16 — the ratio passthrough is gone.
    const renderSettings = {
      pack: renderOpts.pack ?? "highlight",
      ratio: "9:16",
      positionPct: renderOpts.positionPct ?? null,
      scalePct: renderOpts.scalePct ?? 1,
    };
    result.renderSettings = renderSettings;
    for (let i = 0; i < ranked.length; i += 1) {
      const clip = ranked[i];
      log(`rendering clip ${i + 1}/${ranked.length} (${renderSettings.pack}, ${renderSettings.ratio})…`);
      const rendered = await renderClip({
        probe,
        clip: {
          ...clip,
          words: wordsByClip.get(clip) ?? [],
          language: transcript.language,
        },
        workDir,
        opts: { ...renderSettings, shots, faceDetections: clip.faceDetections ?? null },
      });
      result.clips[i].video = `/media/${result.workId}/${rendered.file.split(/[\\/]/).pop()}`;
      result.clips[i].checks = rendered.checks ?? null; // QC plan (Agent A) lands progressively
      onStage("render", `${i + 1}/${ranked.length}`);
    }
    timings.render = ms(t);

    // Post-render packaging: social metadata + poster thumbnails per clip.
    for (let i = 0; i < ranked.length; i += 1) {
      result.clips[i].meta = await generateMetadata(ranked[i], log);
      onStage("render", `meta ${i + 1}/${ranked.length}`);
    }
    for (let i = 0; i < ranked.length; i += 1) {
      try {
        const thumb = await renderThumbnail({ videoPath, clip: ranked[i], workDir });
        result.clips[i].thumb = `/media/${result.workId}/${thumb.split(/[\\/]/).pop()}`;
      } catch (err) {
        log(`thumb failed on #${ranked[i].rank}: ${err.message}`);
      }
      onStage("render", `thumb ${i + 1}/${ranked.length}`);
    }
  }

  result.totalWallSec = ms(t0);
  writeFileSync(resolve(workDir, "rank.json"), JSON.stringify(result, null, 2));
  onStage("done", `${ranked.length} clips · ${(result.totalWallSec / 1000).toFixed(1)}s`);
  return { result, workDir, videoPath, probe, shots };
}

/** Load the whisper transcript as absolute-time words (snapping + slicing). */
function transcriptWords(workDir) {
  const tPath = resolve(workDir, "transcribe.json");
  if (!existsSync(tPath)) return [];
  const doc = JSON.parse(readFileSync(tPath, "utf8"));
  const words = [];
  for (const seg of doc.transcription ?? []) {
    for (const tok of seg.tokens ?? []) {
      const word = (tok.text ?? "").trim();
      if (!word || word.startsWith("[") || /^[_\-.,]+$/.test(word)) continue;
      words.push({
        start: (tok.offsets?.from ?? 0) / 1000,
        end: (tok.offsets?.to ?? 0) / 1000,
        word,
      });
    }
  }
  return words;
}

/**
 * Slice absolute transcript words into one clip's clip-relative captions.
 * Slices by the FINAL window (±0.25s tolerance for boundary tokens) — words
 * trimmed out by omni/LLM/snap are dropped, never clamped to 0 (caption
 * desync bug).
 */
function sliceWordsForClip(absWords, clip) {
  const start = clip.finalStart ?? clip.start;
  const end = clip.finalEnd ?? clip.end;
  const words = [];
  for (const w of absWords) {
    if (w.start < start - 0.25 || w.end > end + 0.25) continue;
    const relStart = w.start - start;
    const relEnd = w.end - start;
    // Nothing audible left inside the window → drop the token entirely.
    if (relEnd <= relStart || relEnd <= 0.01) continue;
    words.push({ start: Math.max(0, relStart), end: relEnd, word: w.word });
  }
  return words;
}

/** Slice the whisper transcript into per-clip, clip-relative word timings. */
function clipWords(absWords, ranked) {
  const map = new Map();
  for (const clip of ranked) map.set(clip, sliceWordsForClip(absWords, clip));
  return map;
}

const SNAP_RANGE = 0.7; // max distance a shot boundary may move a cut point
const SNAP_MIN_GAP = 0.25; // snapped boundary must sit in a word gap this wide

/**
 * Snap each clip's finalStart/finalEnd to the nearest scene-shot boundary
 * (within SNAP_RANGE) when that boundary does not cut mid-word, then re-slice
 * the clip's caption words from the updated window.
 */
function snapCutsToShots(ranked, shots, absWords, wordsByClip, log = () => {}) {
  if (!shots.length) return;
  for (const clip of ranked) {
    const start = clip.finalStart ?? clip.start;
    const end = clip.finalEnd ?? clip.end;
    const snappedStart = snapEdge(start, shots, absWords);
    const snappedEnd = snapEdge(end, shots, absWords);
    if (snappedStart === start && snappedEnd === end) continue;
    if (snappedEnd - snappedStart < 5) continue; // never snap a clip into a stub
    clip.finalStart = round2(snappedStart);
    clip.finalEnd = round2(snappedEnd);
    clip.durationSec = round2(clip.finalEnd - clip.finalStart);
    wordsByClip.set(clip, sliceWordsForClip(absWords, clip));
    log(
      `snap #${clip.rank}: start ${start.toFixed(2)}→${clip.finalStart} · end ${end.toFixed(2)}→${clip.finalEnd}`,
    );
  }
}

/** Nearest shot boundary to t within SNAP_RANGE whose gap check passes. */
function snapEdge(t, shots, absWords) {
  let best = null;
  let bestDist = Infinity;
  for (const s of shots) {
    for (const b of [s.start, s.end]) {
      const dist = Math.abs(b - t);
      if (dist > SNAP_RANGE || dist >= bestDist) continue;
      if (!gapOk(b, absWords)) continue;
      best = b;
      bestDist = dist;
    }
  }
  return best ?? t;
}

/** True when t falls in a >= 0.25s gap between words, or before/after speech. */
function gapOk(t, absWords) {
  let prevEnd = -Infinity;
  let nextStart = Infinity;
  for (const w of absWords) {
    if (w.start < t && w.end > t) return false; // boundary would cut this word
    if (w.end <= t && w.end > prevEnd) prevEnd = w.end;
    if (w.start >= t && w.start < nextStart) nextStart = w.start;
  }
  if (prevEnd === -Infinity || nextStart === Infinity) return true;
  return nextStart - prevEnd >= SNAP_MIN_GAP;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
