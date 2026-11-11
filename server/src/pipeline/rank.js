/**
 * ShotForge ranking engine — shared by the CLI and the web server.
 * ingest → audio(+energy) → whisper CUDA → shot detect → candidates (speech ∪
 * visual) → heuristic pre-score → lfm3 re-rank → lfm3-vl frames → ensemble.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

import { PATHS, verifyPaths } from "../paths.js";
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
 * @param {{pack?:string, ratio?:string, positionPct?:number, scalePct?:number}} [opts.render]
 * @param {boolean} [opts.autoRender=true]  render every ranked clip after scoring
 * @param {(stage:string, note?:string)=>void} [opts.onStage]
 * @param {(line:string)=>void} [opts.log]
 */
export async function runRank({
  source,
  workRoot,
  top = 10,
  render: renderOpts = {},
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
  timings.ensemble = ms(t);

  onStage("omni");
  t = Date.now();
  await analyzeClips(videoPath, ranked, workDir, log);
  for (const c of ranked) applyOmniAdjustments(c);
  timings.omni = ms(t);

  // Word-level caption timing for each clip (sliced from the transcript).
  const wordsByClip = clipWords(workDir, ranked);

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
    })),
  };

  if (autoRender) {
    onStage("render");
    t = Date.now();
    const renderSettings = {
      pack: renderOpts.pack ?? "beast-pop",
      ratio: renderOpts.ratio ?? "9:16",
      positionPct: renderOpts.positionPct ?? null,
      scalePct: renderOpts.scalePct ?? 1,
    };
    result.renderSettings = renderSettings;
    for (let i = 0; i < ranked.length; i += 1) {
      const clip = ranked[i];
      log(`rendering clip ${i + 1}/${ranked.length} (${renderSettings.pack}, ${renderSettings.ratio})…`);
      const { file } = await renderClip({
        probe,
        clip: {
          ...clip,
          words: wordsByClip.get(clip) ?? [],
          language: transcript.language,
        },
        workDir,
        opts: { ...renderSettings, shots, faceDetections: clip.faceDetections ?? null },
      });
      result.clips[i].video = `/media/${result.workId}/${file.split(/[\\/]/).pop()}`;
      onStage("render", `${i + 1}/${ranked.length}`);
    }
    timings.render = ms(t);
  }

  result.totalWallSec = ms(t0);
  writeFileSync(resolve(workDir, "rank.json"), JSON.stringify(result, null, 2));
  onStage("done", `${ranked.length} clips · ${(result.totalWallSec / 1000).toFixed(1)}s`);
  return { result, workDir, videoPath, probe, shots };
}

/** Slice the whisper transcript into per-clip, clip-relative word timings. */
function clipWords(workDir, ranked) {
  const tPath = resolve(workDir, "transcribe.json");
  const map = new Map();
  if (!existsSync(tPath)) return map;
  const doc = JSON.parse(readFileSync(tPath, "utf8"));
  for (const clip of ranked) {
    const offset = clip.finalStart ?? clip.start;
    const words = [];
    for (const seg of doc.transcription ?? []) {
      for (const tok of seg.tokens ?? []) {
        const word = (tok.text ?? "").trim();
        if (!word || word.startsWith("[") || /^[_\-.,]+$/.test(word)) continue;
        const s = (tok.offsets?.from ?? 0) / 1000;
        const e = (tok.offsets?.to ?? 0) / 1000;
        if (s >= (clip.start ?? clip.finalStart) - 0.3 && e <= (clip.end ?? clip.finalEnd) + 0.3) {
          words.push({ start: Math.max(0, s - offset), end: Math.max(0, e - offset), word });
        }
      }
    }
    map.set(clip, words);
  }
  return map;
}
