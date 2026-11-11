import { PATHS } from "../paths.js";
import { run } from "../proc.js";

/**
 * Post-render output verification: ffprobe the rendered clip and assert the
 * 9:16 container, duration fidelity and audio presence. Pure reporting —
 * renderClip returns these checks alongside the file path so callers (and the
 * UI) can flag renders that silently came out wrong.
 *
 * @param {{file:string, expectedSec:number, sourceHasAudio:boolean}} params
 * @returns {Promise<{width:number, height:number, durationSec:number,
 *   expectedSec:number, audioOk:boolean, pass:boolean, problems:string[]}>}
 */
export async function checkOutput({ file, expectedSec, sourceHasAudio }) {
  const checks = {
    width: 0,
    height: 0,
    durationSec: 0,
    expectedSec,
    audioOk: false,
    pass: false,
    problems: [],
  };

  try {
    const { stdout } = await run(
      PATHS.ffprobe,
      [
        "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        file,
      ],
      { timeoutMs: 60_000 },
    );
    const probe = JSON.parse(stdout);
    const video = probe.streams?.find((s) => s.codec_type === "video");
    const audio = probe.streams?.find((s) => s.codec_type === "audio");
    checks.width = video?.width ?? 0;
    checks.height = video?.height ?? 0;
    checks.durationSec = Number(probe.format?.duration ?? video?.duration ?? 0);
    checks.audioOk = Boolean(audio) === Boolean(sourceHasAudio);

    if (checks.width !== 1080) checks.problems.push(`width ${checks.width} != 1080`);
    if (checks.height !== 1920) checks.problems.push(`height ${checks.height} != 1920`);
    if (Math.abs(checks.durationSec - expectedSec) > 0.6) {
      checks.problems.push(
        `duration ${checks.durationSec.toFixed(2)}s differs from expected ${expectedSec.toFixed(2)}s by more than 0.6s`,
      );
    }
    if (!checks.audioOk) {
      checks.problems.push(
        sourceHasAudio ? "audio stream missing in output" : "unexpected audio stream in output",
      );
    }
    checks.pass = checks.problems.length === 0;
  } catch (err) {
    checks.problems.push(`ffprobe failed: ${err.message}`);
  }

  return checks;
}
