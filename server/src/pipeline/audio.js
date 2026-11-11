import { PATHS } from "../paths.js";
import { run } from "../proc.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Extract 16 kHz mono WAV (the whisper input), ClipShlip-proven recipe. */
export async function extractAudio(source, workDir) {
  const wavPath = join(workDir, "audio.wav");
  await run(
    PATHS.ffmpeg,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", source,
      "-vn",
      "-ac", "1", "-ar", "16000",
      "-c:a", "pcm_s16le",
      wavPath,
    ],
    { timeoutMs: 900_000 },
  );
  return { wavPath };
}

/**
 * Per-second RMS loudness curve, computed straight from the 16k mono PCM.
 * No external parsing: the WAV is plain 16-bit PCM we just produced.
 */
export function energyCurve(wavPath) {
  const buf = readFileSync(wavPath);
  // Skip to the data chunk (handle 44-byte canonical layout from ffmpeg).
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("audio.wav: data chunk not found");

  const bytesPerSample = 2; // pcm_s16le mono
  const sampleRate = 16000;
  const samplesPerSecond = sampleRate;
  const seconds = Math.floor(dataLength / (bytesPerSample * samplesPerSecond));
  const curve = new Float32Array(seconds);
  for (let s = 0; s < seconds; s += 1) {
    let sum = 0;
    const start = dataOffset + s * samplesPerSecond * bytesPerSample;
    for (let i = 0; i < samplesPerSecond; i += 1) {
      const v = buf.readInt16LE(start + i * bytesPerSample) / 32768;
      sum += v * v;
    }
    curve[s] = Math.sqrt(sum / samplesPerSecond);
  }
  return curve; // rms per second, 0..~1
}
