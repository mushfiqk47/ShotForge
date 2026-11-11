/**
 * Omni video analysis: lfm3-omni LOOKS at each ranked clip (frame sequence via
 * Ollama `images` — the HTTP API has no video input) and judges camera framing,
 * subject position, motion and cut quality. Results refine the cut points and
 * anchor the reframe crop, and are surfaced as a "camera note" on the clip.
 */
import { PATHS } from "../paths.js";
import { run } from "../proc.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unloadModel } from "../ollama.js";

const FRAMES = 6;

async function chat(body, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${PATHS.ollama}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Extract FRAMES evenly spaced across [start,end] as small base64 JPEGs. */
export async function extractSequence(videoPath, clip, workDir, { frames = FRAMES, size = 384 } = {}) {
  const start = clip.finalStart ?? clip.start;
  const end = clip.finalEnd ?? clip.end;
  const span = end - start;
  const stamps = Array.from(
    { length: frames },
    (_, i) => start + (span * (i + 0.5)) / frames,
  );
  const images = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const out = join(workDir, `omni_${start.toFixed(1)}_${i}.jpg`);
    await run(
      PATHS.ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", stamps[i].toFixed(2),
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", `scale=${size}:-2`,
        "-q:v", "6",
        out,
      ],
      { timeoutMs: 60_000 },
    );
    images.push(readFileSync(out).toString("base64"));
  }
  return { images, stamps, start, end, span };
}

const SCHEMA = {
  type: "object",
  properties: {
    framing: { type: "string" },
    subjectPosition: { type: "string", enum: ["left", "center", "right"] },
    motionScore: { type: "number" },
    cutQuality: { type: "string" },
    suggestedCutSec: { type: "array", items: { type: "number" } },
  },
  required: ["framing", "subjectPosition", "motionScore", "cutQuality"],
};

/**
 * @returns {{framing, subjectPosition, motionScore, cutQuality, suggestedCutSec, notes}}
 */
export async function analyzeFraming({ videoPath, clip, workDir }) {
  const { images, span } = await extractSequence(videoPath, clip, workDir);
  const json = await chat({
    model: PATHS.models.omni ?? "lfm3-omni:2b-q4_K_M",
    stream: false,
    think: false,
    format: SCHEMA,
    keep_alive: 0,
    options: { temperature: 0.2, num_ctx: 4096, num_predict: 200 },
    messages: [
      {
        role: "user",
        content: [
          `These ${images.length} frames are sampled IN TIME ORDER across one ${span.toFixed(1)}s video moment (start → end).`,
          "You are a short-form video editor deciding camera and cuts:",
          "- framing: what the camera shows and whether the subject is well placed (max 14 words)",
          "- subjectPosition: where the main subject sits horizontally (left/center/right)",
          "- motionScore: 0-100 visual energy across the moment",
          "- cutQuality: would this survive as a standalone short? (max 12 words)",
          "- suggestedCutSec: absolute seconds INSIDE this window where a tighter start or end would improve the clip (empty array if the window is already tight)",
          "JSON only.",
        ].join("\n"),
        images,
      },
    ],
  });
  const parsed = JSON.parse(json.message?.content ?? "{}");
  return {
    framing: String(parsed.framing ?? "").slice(0, 160),
    subjectPosition: ["left", "center", "right"].includes(parsed.subjectPosition)
      ? parsed.subjectPosition
      : "center",
    motionScore: Math.max(0, Math.min(100, Math.round(Number(parsed.motionScore) || 50))),
    cutQuality: String(parsed.cutQuality ?? "").slice(0, 140),
    suggestedCutSec: Array.isArray(parsed.suggestedCutSec)
      ? parsed.suggestedCutSec
          .map(Number)
          .filter((n) => Number.isFinite(n) && n >= clip.start && n <= clip.end)
      : [],
  };
}

/** Analyze a list of ranked clips sequentially; attach clip.omni. */
export async function analyzeClips(videoPath, clips, workDir, log = () => {}) {
  for (const clip of clips) {
    try {
      clip.omni = await analyzeFraming({ videoPath, clip, workDir });
      log(
        `omni #${clip.rank}: ${clip.omni.framing} | subject ${clip.omni.subjectPosition} | motion ${clip.omni.motionScore}`,
      );
    } catch (err) {
      log(`omni failed on #${clip.rank}: ${err.message}`);
      clip.omni = null;
    }
  }
  await unloadModel("lfm3-omni:2b-q4_K_M");
  return clips;
}

/** Apply omni suggestions: tighten cuts and derive a crop anchor for reframe. */
export function applyOmniAdjustments(clip) {
  if (!clip.omni) return clip;
  const start = clip.finalStart ?? clip.start;
  const end = clip.finalEnd ?? clip.end;
  let newStart = start;
  let newEnd = end;

  const cuts = clip.omni.suggestedCutSec ?? [];
  if (cuts.length && end - start > 14) {
    const before = cuts.filter((c) => c - start >= 2 && c - start <= (end - start) * 0.3);
    const after = cuts.filter((c) => end - c >= 2 && c - start >= (end - start) * 0.6);
    if (before.length) newStart = Math.min(...before);
    if (after.length) newEnd = Math.max(...after);
    if (newEnd - newStart < 10) {
      newStart = start;
      newEnd = end;
    }
  }
  clip.finalStart = Math.round(newStart * 100) / 100;
  clip.finalEnd = Math.round(newEnd * 100) / 100;
  clip.durationSec = Math.round((clip.finalEnd - clip.finalStart) * 100) / 100;

  // Crop anchor: omni's subject position feeds the reframe face-detection shape.
  const cx = clip.omni.subjectPosition === "left" ? 0.32 : clip.omni.subjectPosition === "right" ? 0.68 : 0.5;
  const mid = (clip.finalStart + clip.finalEnd) / 2;
  clip.faceDetections = [
    { t: clip.finalStart, cx },
    { t: mid, cx },
    { t: clip.finalEnd, cx },
  ];
  clip.cameraNote = `${clip.omni.framing} · subject ${clip.omni.subjectPosition} · motion ${clip.omni.motionScore}`;
  return clip;
}
