import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../paths.js";
import { run } from "../proc.js";
import { planReframe } from "./reframe.js";
import { buildAss } from "./captions.js";
import { FONT_FILES } from "./font-files.js";

/**
 * Render one clip: cut → reframe → karaoke captions → h264_nvenc + aac.
 * ffmpeg runs with cwd=workDir so libass gets simple relative paths
 * (ass file + fonts dir), sidestepping Windows path escaping.
 *
 * @param {object} params
 * @param {object} params.probe      from ingest (width/height/…)
 * @param {object} params.clip       ranked clip {finalStart, finalEnd, words?, language?}
 * @param {string} params.workDir
 * @param {{pack?:string, ratio?:string, captions?:boolean, faceDetections?:Array|null, shots?:Array}} [params.opts]
 * @returns {Promise<{file:string}>}
 */
export async function renderClip({ probe, clip, workDir, opts = {} }) {
  const {
    pack = "beast-pop",
    ratio = "9:16",
    captions = true,
    positionPct = null,
    scalePct = 1,
    faceDetections = null,
    shots = [],
  } = opts;

  const plan = planReframe({
    width: probe.width,
    height: probe.height,
    ratio,
    faces: faceDetections,
    shots,
  });

  let assPath = null;
  if (captions && clip.words?.length) {
    const ass = buildAss(clip.words, {
      pack,
      language: clip.language || "en",
      width: plan.outW,
      height: plan.outH,
      positionPct,
      scalePct,
    });
    assPath = "captions.ass";
    writeWork(workDir, assPath, ass);
    mkdirSync(join(workDir, "fonts"), { recursive: true });
    copyFonts(workDir);
  }

  const filters = [plan.filter];
  if (assPath) {
    filters.push(`subtitles=${assPath}:fontsdir=fonts`);
  }
  const filterChain = `[0:v]${filters.join(",")}[vout]`;

  const duration = (clip.finalEnd ?? clip.end) - (clip.finalStart ?? clip.start);
  const outName = `clip_${(clip.finalStart ?? clip.start).toFixed(0)}_${(clip.finalEnd ?? clip.end).toFixed(0)}.mp4`;

  await run(
    PATHS.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", (clip.finalStart ?? clip.start).toFixed(2),
      "-t", duration.toFixed(2),
      "-i", probe.videoPath,
      "-filter_complex", filterChain,
      "-map", "[vout]",
      ...(probe.hasAudio ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
      "-c:v", "h264_nvenc",
      "-preset", "p4",
      "-rc", "vbr",
      "-cq", "21",
      "-b:v", "0",
      "-maxrate", "12M",
      "-bufsize", "24M",
      "-r", String(probe.fps || 25),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outName,
    ],
    { timeoutMs: 1_800_000, cwd: workDir },
  );

  return { file: join(workDir, outName), plan };
}

function copyFonts(workDir) {
  for (const f of FONT_FILES) {
    try {
      copyFileSync(join(PATHS.fontsDir, f), join(workDir, "fonts", f));
    } catch {
      /* optional font missing — libass falls back */
    }
  }
}

function writeWork(workDir, name, content) {
  writeFileSync(join(workDir, name), content);
}
