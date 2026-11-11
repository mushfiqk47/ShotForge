/**
 * Per-clip social metadata: hook-style title, 5 hashtags and a short
 * description — the upload-ready text package generated for every rendered
 * clip. One sequential lfm3 call per clip; returns null on failure, never
 * throws.
 */
import { PATHS } from "../paths.js";
import { chatJson } from "../ollama.js";

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
    description: { type: "string" },
  },
  required: ["title", "hashtags", "description"],
};

const MAX_TITLE = 70;
const MAX_DESCRIPTION = 200;
const WANTED_HASHTAGS = 5;
const FALLBACK_TAGS = ["#shorts", "#viral", "#clips", "#reels", "#trending"];

/**
 * @param {object} clip  ranked clip ({hook, text/transcript, reason})
 * @param {(line:string)=>void} [log]
 * @returns {Promise<{title:string, hashtags:string[], description:string}|null>}
 */
export async function generateMetadata(clip, log = () => {}) {
  try {
    const transcript = String(clip.transcript ?? clip.text ?? "").slice(0, 400);
    const prompt = [
      "You write social metadata for one short-form video clip (TikTok/Reels/Shorts, but platform-agnostic).",
      clip.hook ? `Hook (first line spoken): ${clip.hook}` : "",
      transcript ? `Transcript (start of the clip): ${transcript}` : "",
      clip.reason ? `Why this clip works: ${clip.reason}` : "",
      "Write:",
      `- title: hook-style, max ${MAX_TITLE} characters. Concrete and specific, no clickbait slop ("you won't believe", "shocking", emoji spam), no hashtags inside the title.`,
      `- hashtags: exactly ${WANTED_HASHTAGS} lowercase hashtags, each starting with "#", platform-agnostic and relevant to the content.`,
      `- description: max ${MAX_DESCRIPTION} characters, one or two plain sentences that add context or a takeaway.`,
      "Respond with JSON only.",
    ]
      .filter(Boolean)
      .join("\n");

    const parsed = await chatJson({
      model: PATHS.models.text,
      schema: SCHEMA,
      prompt,
      options: { temperature: 0.4, num_predict: 220 },
      timeoutMs: 120_000,
      log,
    });

    const meta = {
      title: clampText(parsed.title, MAX_TITLE),
      hashtags: normalizeHashtags(parsed.hashtags),
      description: clampText(parsed.description, MAX_DESCRIPTION),
    };
    if (!meta.title || !meta.hashtags.length || !meta.description) {
      log("metadata: unusable model output");
      return null;
    }
    return meta;
  } catch (err) {
    log(`metadata failed: ${err.message}`);
    return null;
  }
}

/** Collapse whitespace and clamp to max chars with a trailing ellipsis. */
function clampText(value, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Ensure "#" prefix, lowercase, exactly WANTED_HASHTAGS entries (padded). */
function normalizeHashtags(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const tag = String(raw ?? "")
      .trim()
      .replace(/^#+/, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(`#${tag}`);
    if (out.length >= WANTED_HASHTAGS) return out;
  }
  for (const tag of FALLBACK_TAGS) {
    if (out.length >= WANTED_HASHTAGS) break;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
