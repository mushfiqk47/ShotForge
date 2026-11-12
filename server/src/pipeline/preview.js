import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../paths.js";
import { run } from "../proc.js";
import { buildAss, PACKS } from "./captions.js";
import { FONT_FILES } from "./font-files.js";

/**
 * WYSIWYG style preview: burn the REAL caption pipeline (same buildAss → ASS
 * → libass path as render) onto one representative source frame.
 * Returns JPEG bytes so the UI can show exactly how a clip will look.
 */
export async function renderStylePreview({
  probe,
  clip,
  workDir,
  pack = "highlight",
  positionPct = null,
  scalePct = 1,
  ratio = "9:16",
}) {
  const previewDir = join(workDir, "previews");
  mkdirSync(join(previewDir, "fonts"), { recursive: true });
  copyFonts(previewDir);

  // Pick a moment INSIDE the clip where captions are mid-line (shows the
  // karaoke fill state), then rebase word times to that moment — the grabbed
  // frame's PTS restarts at 0 after input seeking.
  const clipStart = clip.finalStart ?? clip.start;
  const clipEnd = clip.finalEnd ?? clip.end;
  const wordList = clip.words?.length ? clip.words : sampleWords(clip, probe);
  const lastEnd = wordList.length ? wordList[wordList.length - 1].end : 4;
  const at = Math.min(1.2, Math.max(0.4, lastEnd / 2));
  const words = wordList
    .filter((w) => w.end > at - 0.1 && w.start < at + 2.2)
    .map((w) => ({ ...w, start: w.start - at + 0.15, end: w.end - at + 0.15 }));
  if (!words.length) {
    // Fallback: synthetic line right at the visible moment.
    const sample = sampleWords(clip, probe);
    for (const w of sample) {
      w.start += 0.15;
      w.end += 0.15;
    }
    words.push(...sample);
  }

  const ass = buildAss(words, {
    pack,
    language: clip.language || "en",
    width: 1080,
    height: 1920,
    positionPct,
    scalePct,
  });
  writeFileSync(join(previewDir, "preview.ass"), ass);

  const grabAt = clipStart + at;
  const outName = `preview_${pack}_${Math.round(positionPct ?? -1)}_${Math.round(scalePct * 100)}.jpg`;
  await run(
    PATHS.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", grabAt.toFixed(2),
      "-i", probe.videoPath,
      "-frames:v", "1",
      "-vf",
      `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles=preview.ass:fontsdir=fonts,scale=${probe.previewWidth ?? 405}:${probe.previewHeight ?? 720}`,
      "-q:v", "4",
      outName,
    ],
    { timeoutMs: 60_000, cwd: previewDir },
  );
  return join(previewDir, outName);
}

function sampleWords(clip, probe) {
  const text =
    clip.hook ||
    clip.transcript ||
    "This is how your captions will look after the render";
  const parts = text.split(/\s+/).slice(0, 8);
  const per = 0.5;
  let t = 0;
  return parts.map((word) => {
    const w = { start: t, end: t + per, word };
    t += per;
    return w;
  });
}

function copyFonts(dir) {
  for (const f of FONT_FILES) {
    try {
      copyFileSync(join(PATHS.fontsDir, f), join(dir, "fonts", f));
    } catch {
      /* optional font missing */
    }
  }
}

/**
 * Job-independent WYSIWYG preview: the same ASS pipeline burned onto a neutral
 * synthetic frame, for the Typography step before any video is processed.
 * `band: true` crops to the caption area (CapCut-style preset thumbnails —
 * the caption fills the tile); full frame otherwise.
 */
export async function renderSamplePreview({
  pack = "highlight",
  positionPct = null,
  scalePct = 1,
  width = 405,
  height = 720,
  text = "This is how your captions will look",
  band = false,
}) {
  const dir = join(PATHS.fontsDir, "..", ".preview-cache");
  mkdirSync(join(dir, "fonts"), { recursive: true });
  copyFonts(dir);

  const per = 0.55;
  let t = 0.3;
  const words = text.split(/\s+/).map((word) => {
    const w = { start: t, end: t + per, word };
    t += per;
    return w;
  });
  const ass = buildAss(words, {
    pack,
    language: "en",
    width: 1080,
    height: 1920,
    positionPct,
    scalePct,
  });
  writeFileSync(join(dir, "sample.ass"), ass);

  const outName = `sample_${pack}_${Math.round(positionPct ?? -1)}_${Math.round(scalePct * 100)}${band ? "_band" : ""}.jpg`;
  if (existsSync(join(dir, outName))) return join(dir, outName);

  // Caption band: same MarginV math as buildAss, cropped around the caption.
  const posPct = positionPct ?? PACKS[pack]?.positionPct ?? 20;
  const marginV = 1920 * Math.min(0.92, Math.max(0.02, posPct / 100));
  const bandH = 560;
  const bandY = Math.round(Math.min(1920 - bandH, Math.max(0, 1920 - marginV - bandH / 2)));
  const vf = band
    ? `subtitles=sample.ass:fontsdir=fonts,crop=1080:${bandH}:0:${bandY},scale=${width}:${Math.round((width * bandH) / 1080)}`
    : `subtitles=sample.ass:fontsdir=fonts,scale=${width}:${height}`;

  await run(
    PATHS.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=0x22201e:size=1080x1920:duration=6:rate=1`,
      "-vf", vf,
      "-ss", "2.2",
      "-frames:v", "1",
      "-q:v", "4",
      outName,
    ],
    { timeoutMs: 60_000, cwd: dir },
  );
  return join(dir, outName);
}
