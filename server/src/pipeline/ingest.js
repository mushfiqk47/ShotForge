import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../paths.js";
import { run } from "../proc.js";

/**
 * Probe a local video file. URL and upload ingestion are handled by the
 * caller before this stage (yt-dlp / saved temp file).
 */
export async function ingest(videoPath, workDir) {
  mkdirSync(workDir, { recursive: true });
  const { stdout } = await run(
    PATHS.ffprobe,
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format", "-show_streams",
      videoPath,
    ],
    { timeoutMs: 60_000 },
  );
  const probe = JSON.parse(stdout);
  const video = probe.streams?.find((s) => s.codec_type === "video");
  const audio = probe.streams?.find((s) => s.codec_type === "audio");
  if (!video) throw new Error("No video stream found");
  return {
    videoPath,
    workDir,
    width: video.width,
    height: video.height,
    durationSec: Number(probe.format?.duration ?? video.duration ?? 0),
    fps: evalFps(video.avg_frame_rate ?? video.r_frame_rate ?? "25/1"),
    hasAudio: Boolean(audio),
    sizeBytes: Number(probe.format?.size ?? 0),
  };
}

function evalFps(ratio) {
  const [num, den] = String(ratio).split("/").map(Number);
  if (!num) return 25;
  return den ? num / den : num;
}
