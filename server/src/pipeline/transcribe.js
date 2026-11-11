import { PATHS } from "../paths.js";
import { run } from "../proc.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Word-level transcription with the local whisper.cpp CUDA build.
 * Same invocation shape ClipShlip uses (proven against this exact binary):
 *   whisper-cli -m <model> -f audio.wav --output-json-full -l auto -t 14 -mc 0
 */
export async function transcribe(wavPath, workDir) {
  const outPrefix = join(workDir, "transcribe");
  await run(
    PATHS.whisperCli,
    [
      "-m", PATHS.whisperModel,
      "-f", wavPath,
      "--output-json-full",
      "-of", outPrefix,
      "-l", "auto",
      "-t", "14",
      "-mc", "0",
      "-np",
    ],
    { timeoutMs: 3_600_000 },
  );

  const raw = JSON.parse(readFileSync(`${outPrefix}.json`, "utf8"));
  const segments = [];
  const words = [];
  for (const seg of raw.transcription ?? []) {
    const segStart = ts(seg.offsets?.from);
    const segEnd = ts(seg.offsets?.to);
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    segments.push({ start: segStart, end: segEnd, text });
    for (const token of seg.tokens ?? []) {
      const word = (token.text ?? "").trim();
      if (!word) continue;
      words.push({
        start: ts(token.offsets?.from),
        end: ts(token.offsets?.to),
        word,
        segmentId: segments.length - 1,
      });
    }
  }
  return { language: raw.result?.language ?? "auto", segments, words };

  function ts(ms) {
    return Number.isFinite(ms) ? ms / 1000 : 0;
  }
}
