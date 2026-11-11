import { PATHS } from "../paths.js";
import { run } from "../proc.js";

/**
 * Shot boundaries via ffmpeg's scene metric. Returns cut times (seconds).
 * select=gt(scene,threshold)+showinfo prints pts_time for every detected cut.
 */
export async function detectShots(source, { threshold = 0.3 } = {}) {
  const { stderr } = await run(
    PATHS.ffmpeg,
    [
      "-hide_banner",
      "-i", source,
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-an",
      "-f", "null",
      "-",
    ],
    { timeoutMs: 1_800_000 },
  );
  const cuts = [];
  const re = /pts_time:([0-9.]+)/g;
  let match;
  while ((match = re.exec(stderr)) !== null) {
    cuts.push(Number(match[1]));
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/** Turn cut times into shot spans [start,end) covering the whole video. */
export function shotsFromCuts(cuts, durationSec) {
  const boundaries = [0, ...cuts, durationSec].filter(
    (v, i, arr) => i === 0 || v > arr[i - 1],
  );
  const shots = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    shots.push({ start: boundaries[i], end: boundaries[i + 1] });
  }
  return shots;
}
