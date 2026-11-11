import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Absolute paths to every local binary/model ShotForge reuses.
 * All are verified at startup; nothing is downloaded automatically.
 */
const APPDATA = process.env.APPDATA || join(homedir(), "AppData", "Roaming");

export const PATHS = {
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",

  whisperCli: join(
    APPDATA,
    "clipshlip",
    "whisper-gpu-pack",
    "whisper-cli.exe",
  ),
  whisperModel: join(
    APPDATA,
    "clipshlip",
    "models",
    "ggml-large-v3-turbo-q8_0.bin",
  ),

  ytdlp: join(APPDATA, "clipshlip", "tools", "yt-dlp.exe"),

  ollama: "http://localhost:11434",
  models: { text: "lfm3", vision: "lfm3-vl:2b-q4_K_M", omni: "lfm3-omni:2b-q4_K_M" },

  // Fonts (OFL-licensed) copied from the ClipShlip shipment into assets/fonts.
  fontsDir: join(import.meta.dirname, "..", "..", "assets", "fonts"),
};

export function verifyPaths() {
  const problems = [];
  for (const [name, p] of Object.entries(PATHS)) {
    if (typeof p !== "string") continue;
    if (p.startsWith("http") || p === "ffmpeg" || p === "ffprobe") continue;
    if (!existsSync(p)) problems.push(`${name}: missing ${p}`);
  }
  return problems;
}

/** Working directory per source video (hashed) for all intermediate artifacts. */
export function workDirFor(root, source) {
  return join(root, ".work", source.replace(/[^a-z0-9._-]+/gi, "_").slice(-80));
}
