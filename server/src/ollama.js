import { PATHS } from "./paths.js";

/**
 * Minimal Ollama client tuned for ShotForge's 6 GB VRAM schedule:
 *  - every call carries an explicit JSON schema (Ollama `format`) so output is parseable;
 *  - calls pass keep_alive: "0" so the GPU frees between pipeline phases;
 *  - vision calls use the Ollama chat `images` array (base64, no data: prefix).
 */

async function request(endpoint, body, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${PATHS.ollama}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama ${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Force-unload a model so the next phase gets the whole GPU. */
export async function unloadModel(model) {
  try {
    await request("/api/generate", { model, prompt: "", keep_alive: 0 }, 30_000);
  } catch {
    /* unload best-effort */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One sequential JSON-schema chat call with a hard timeout and a slow retry —
 * VRAM contention between pipeline phases makes transient Ollama failures
 * routine, so callers get one bounded 30s-later retry instead of a crash.
 * Carries think:false, `format` schema and keep_alive:0 like every call here.
 *
 * @param {object} p
 * @param {string} p.model
 * @param {object} p.schema          JSON schema passed as Ollama `format`
 * @param {string} p.prompt
 * @param {string[]} [p.images]      base64 JPEGs (no data: prefix)
 * @param {object} [p.options]       extra Ollama options (temperature, num_predict…)
 * @param {number} [p.timeoutMs]
 * @param {number} [p.retries]       extra attempts after a failure (default 1)
 * @param {(line:string)=>void} [p.log]
 * @returns {Promise<object>} parsed JSON message content
 */
export async function chatJson({
  model,
  schema,
  prompt,
  images,
  options = {},
  timeoutMs = 180_000,
  retries = 1,
  log = () => {},
}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      log(`ollama ${model} failed (${lastErr?.message ?? "unknown"}) — retrying in 30s`);
      await sleep(30_000);
    }
    try {
      const json = await request(
        "/api/chat",
        {
          model,
          stream: false,
          think: false,
          format: schema,
          keep_alive: 0,
          options: { temperature: 0.2, num_ctx: 8192, ...options },
          messages: [{ role: "user", content: prompt, ...(images ? { images } : {}) }],
        },
        timeoutMs,
      );
      return JSON.parse(json.message?.content ?? "{}");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export const OLLAMA_RUBRIC = `You are a short-form video editor scoring candidate clips for TikTok/Reels/Shorts.
A 10/10 clip: hooks in the first 2 seconds, has one clear idea or emotional beat, ends on a payoff, and works without context.
Judge ONLY from the material given. Be strict: most clips are 40-70, outstanding ones 80+, weak ones under 35.`;

/**
 * Re-rank one candidate with the text model.
 * @returns {{score:number, hook:string, reason:string, keepStart:number|null, keepEnd:number|null}}
 */
export async function scoreCandidateText({
  candidate,
  surrounding = "",
  durationTarget = "auto",
}) {
  const schema = {
    type: "object",
    properties: {
      score: { type: "number" },
      hook: { type: "string" },
      reason: { type: "string" },
      trimStartSec: { type: "number" },
      trimEndSec: { type: "number" },
    },
    required: ["score", "hook", "reason"],
  };
  const prompt = [
    OLLAMA_RUBRIC,
    `Candidate window: ${candidate.start.toFixed(1)}s to ${candidate.end.toFixed(1)}s.`,
    durationTarget !== "auto"
      ? `Target length: about ${durationTarget}s (you may suggest trimming inside the window).`
      : "Target length: 15-45s. If a tighter sub-range is clearly stronger, suggest trimStartSec/trimEndSec inside the window.",
    candidate.text
      ? `Transcript of the window:\n${candidate.text}`
      : "There is no usable speech in this window (visual moment only).",
    candidate.signals?.length
      ? `Automatic detectors flagged: ${candidate.signals.join(", ")}.`
      : "",
    surrounding ? `Adjacent context (do not score this): ${surrounding}` : "",
    "Respond with JSON only: score (0-100), hook (the exact first spoken line or visual hook, max 12 words), reason (max 30 words, name the strongest element), and optional trimStartSec/trimEndSec (absolute seconds) if a tighter cut is stronger.",
  ]
    .filter(Boolean)
    .join("\n");

  const json = await request("/api/chat", {
    model: PATHS.models.text,
    stream: false,
    think: false,
    format: schema,
    keep_alive: 0,
    options: { temperature: 0.2, num_ctx: 8192, num_predict: 300 },
    messages: [{ role: "user", content: prompt }],
  });
  const parsed = JSON.parse(json.message?.content ?? "{}");
  return {
    score: clampScore(parsed.score),
    hook: String(parsed.hook ?? "").slice(0, 140),
    reason: String(parsed.reason ?? "").slice(0, 300),
    keepStart: Number.isFinite(parsed.trimStartSec) ? parsed.trimStartSec : null,
    keepEnd: Number.isFinite(parsed.trimEndSec) ? parsed.trimEndSec : null,
  };
}

/**
 * Visual-interest score for N frames of a candidate (any-genre path).
 * @param {string[]} framesB64  JPEG frames, base64 without data: prefix
 * @returns {{score:number, description:string}}
 */
export async function scoreCandidateVisual({ framesB64, durationSec }) {
  const schema = {
    type: "object",
    properties: {
      score: { type: "number" },
      description: { type: "string" },
    },
    required: ["score", "description"],
  };
  const prompt = [
    OLLAMA_RUBRIC,
    `These ${framesB64.length} frames are sampled across one ${durationSec.toFixed(1)}s moment of a video (start, middle, end).`,
    "Score how engaging this moment is as a standalone short-form clip: motion, visual interest, tension, payoff, aesthetics.",
    "This is a visual-only judgment (assume little or no dialogue).",
    "Respond with JSON only: score (0-100), description (max 25 words, what happens visually).",
  ].join("\n");

  const json = await request("/api/chat", {
    model: PATHS.models.vision,
    stream: false,
    think: false,
    format: schema,
    keep_alive: 0,
    options: { temperature: 0.2, num_ctx: 8192, num_predict: 200 },
    messages: [
      {
        role: "user",
        content: prompt,
        images: framesB64,
      },
    ],
  });
  const parsed = JSON.parse(json.message?.content ?? "{}");
  return {
    score: clampScore(parsed.score),
    description: String(parsed.description ?? "").slice(0, 300),
  };
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}
