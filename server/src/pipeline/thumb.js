/**
 * Poster thumbnail per ranked clip: one full-quality frame grabbed at the
 * visual peak (finalStart + min(1.5, durationSec/3)), scale+crop to exactly
 * 1080x1920 — the same fit/crop pattern the preview pipeline uses.
 */
import { join } from "node:path";
import { PATHS } from "../paths.js";
import { run } from "../proc.js";

/**
 * @param {object} p
 * @param {string} p.videoPath  absolute source video path
 * @param {object} p.clip       ranked clip ({rank, finalStart, finalEnd, durationSec})
 * @param {string} p.workDir
 * @returns {Promise<string>} absolute path to thumb_<rank>.jpg
 */
export async function renderThumbnail({ videoPath, clip, workDir }) {
  const start = clip.finalStart ?? clip.start;
  const durationSec = clip.durationSec ?? (clip.finalEnd ?? clip.end) - start;
  const at = start + Math.min(1.5, Math.max(0, durationSec / 3));
  const outName = `thumb_${clip.rank}.jpg`;
  await run(
    PATHS.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", at.toFixed(2),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
      "-q:v", "3",
      outName,
    ],
    { timeoutMs: 60_000, cwd: workDir },
  );
  return join(workDir, outName);
}
