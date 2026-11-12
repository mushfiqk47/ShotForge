import { PATHS } from "../paths.js";
import { run } from "../proc.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreCandidateText, scoreCandidateVisual, unloadModel } from "../ollama.js";

/** Extract a single JPEG frame (base64) at time t, small enough for the VL model. */
export async function extractFrame(source, timeSec, outPath) {
  await run(
    PATHS.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", timeSec.toFixed(2),
      "-i", source,
      "-frames:v", "1",
      "-vf", "scale=512:-2",
      "-q:v", "5",
      outPath,
    ],
    { timeoutMs: 60_000 },
  );
  return readFileSync(outPath).toString("base64");
}

/**
 * LLM ensemble stage.
 *  - Phase A: lfm3 re-ranks the heuristic-shortlisted candidates (text).
 *  - Phase B: lfm3-vl scores sampled frames (all visual candidates + top speech).
 * Sequential phases keep the 6 GB VRAM schedule safe (keep_alive:0 + explicit unload).
 */
export async function llmScore(source, workDir, candidates, log = () => {}, onStage = () => {}) {
  const shortlist = [...candidates]
    .sort((a, b) => b.heuristic - a.heuristic)
    .slice(0, 24);

  log(`llm:text scoring ${shortlist.length} candidates with ${PATHS.models.text}`);
  let n = 0;
  for (const candidate of shortlist) {
    onStage("llm", `text ${++n}/${shortlist.length}`);
    try {
      candidate.llm = await scoreCandidateText({ candidate });
    } catch (err) {
      log(`llm:text failed on ${candidate.start.toFixed(1)}s: ${err.message}`);
      candidate.llm = { score: 50, hook: "", reason: "LLM scoring unavailable", keepStart: null, keepEnd: null };
    }
  }
  await unloadModel(PATHS.models.text);

  const visualTargets = shortlist.filter(
    (c) => c.kind === "visual" || !c.text,
  );
  const topSpeech = shortlist
    .filter((c) => c.kind === "speech")
    .sort((a, b) => (b.llm?.score ?? 0) - (a.llm?.score ?? 0))
    .slice(0, 6);
  const visionList = [...visualTargets, ...topSpeech];

  log(`llm:vision scoring ${visionList.length} candidates with ${PATHS.models.vision}`);
  n = 0;
  for (const candidate of visionList) {
    onStage("llm", `vision ${++n}/${visionList.length}`);
    try {
      const frames = [];
      const len = candidate.end - candidate.start;
      const stamps = [0.15, 0.5, 0.85].map((f) => candidate.start + len * f);
      for (let i = 0; i < stamps.length; i += 1) {
        frames.push(
          await extractFrame(source, stamps[i], join(workDir, `frame_${candidate.start.toFixed(1)}_${i}.jpg`)),
        );
      }
      candidate.vision = await scoreCandidateVisual({ framesB64: frames, durationSec: len });
    } catch (err) {
      log(`llm:vision failed on ${candidate.start.toFixed(1)}s: ${err.message}`);
      candidate.vision = { score: 50, description: "vision scoring unavailable" };
    }
  }
  await unloadModel(PATHS.models.vision);

  return shortlist;
}
