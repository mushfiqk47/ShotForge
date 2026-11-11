#!/usr/bin/env node
/**
 * ShotForge M2 CLI: render ranked clips into vertical mp4s.
 *   node server/src/cli-render.js <videoPath> [--rank rankFile.json] [--index 1,2,3]
 *        [--pack highlight|classic|karaoke|minimal] [--ratio 9:16|1:1|16:9] [--no-captions]
 *
 * Reads the rank file written by cli-rank.js (re-uses its .work dir for the
 * transcript words) and renders each selected clip with NVENC.
 */
import { resolve, dirname } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Buffer } from "node:buffer";

import { ingest } from "./pipeline/ingest.js";
import { transcribe } from "./pipeline/transcribe.js";
import { detectShots, shotsFromCuts } from "./pipeline/detect.js";
import { renderClip } from "./pipeline/render.js";

const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("usage: node cli-render.js <videoPath> [--rank FILE] [--index 1,2] [--pack highlight] [--ratio 9:16] [--no-captions]");
  process.exit(1);
}
const source = resolve(args[0]);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const pack = flag("--pack", "highlight");
const ratio = flag("--ratio", "9:16");
const captions = !args.includes("--no-captions");
const rankFile = flag("--rank", null);
const indexes = flag("--index", "1,2,3")
  .split(",")
  .map((s) => Number(s.trim()));

const workDir = resolve(".work", Buffer.from(source).toString("base64url").slice(-60));
if (!existsSync(workDir)) {
  console.error(`No work dir for this video — run cli-rank.js first: ${workDir}`);
  process.exit(1);
}
const rankPath = rankFile
  ? resolve(rankFile)
  : resolve(workDir, "rank.json");
if (!existsSync(rankPath)) {
  console.error(`Rank file not found: ${rankPath}`);
  process.exit(1);
}
const ranked = JSON.parse(readFileSync(rankPath, "utf8"));
const picks = ranked.clips.filter((c) => indexes.includes(c.rank));
if (!picks.length) {
  console.error(`No clips with rank in [${indexes.join(",")}] — available: ${ranked.clips.map((c) => c.rank).join(", ")}`);
  process.exit(1);
}

console.log(`[shotforge] probing…`);
const probe = await ingest(source, workDir);

console.log(`[shotforge] re-transcribing for word-level caption timing…`);
// cli-rank saved the whisper JSON in the work dir — reuse if present, else redo.
const wordsFor = {};
for (const clip of picks) {
  wordsFor[clip.rank] = windowWords(ranked, clip);
}
function windowWords(rankDoc, clip) {
  // words were not persisted per clip; if a transcript.json exists, slice it.
  const tPath = resolve(workDir, "transcribe.json");
  if (!existsSync(tPath)) return [];
  const doc = JSON.parse(readFileSync(tPath, "utf8"));
  const offset = clip.finalStart ?? clip.start; // rendered clip restarts at 0
  const words = [];
  for (const seg of doc.transcription ?? []) {
    for (const tok of seg.tokens ?? []) {
      const word = (tok.text ?? "").trim();
      if (!word || word.startsWith("[") || /^[_\-.,]+$/.test(word)) continue;
      const s = (tok.offsets?.from ?? 0) / 1000;
      const e = (tok.offsets?.to ?? 0) / 1000;
      if (s >= clip.start - 0.2 && e <= clip.end + 0.2) {
        words.push({ start: Math.max(0, s - offset), end: Math.max(0, e - offset), word });
      }
    }
  }
  return words;
}

console.log(`[shotforge] shots for motion anchoring…`);
const cuts = await detectShots(source);
const shots = shotsFromCuts(cuts, probe.durationSec);

const outputs = [];
for (const clip of picks) {
  const full = {
    ...clip,
    words: wordsFor[clip.rank],
    language: ranked.language,
  };
  console.log(`[shotforge] rendering #${clip.rank} (${clip.start.toFixed(1)}→${clip.end.toFixed(1)}s, ${pack}, ${ratio})…`);
  const { file, plan } = await renderClip({
    probe,
    clip: full,
    workDir,
    opts: { pack, ratio, captions, shots },
  });
  console.log(`  → ${file} (mode=${plan.mode})`);
  outputs.push({ rank: clip.rank, file, score: clip.score });
}

const manifest = {
  source,
  pack,
  ratio,
  outputs,
};
writeFileSync(resolve(workDir, "render-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n[shotforge] done: ${outputs.length} clip(s) → manifest ${resolve(workDir, "render-manifest.json")}`);
