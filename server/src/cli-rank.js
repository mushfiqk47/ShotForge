#!/usr/bin/env node
/**
 * ShotForge CLI: rank the best moments in any video.
 *   node server/src/cli-rank.js <videoPath|URL> [--top N] [--out FILE]
 */
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

import { runRank } from "./pipeline/rank.js";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help") {
  console.log("usage: node cli-rank.js <videoPath|URL> [--top N] [--out FILE]");
  process.exit(args.length === 0 ? 1 : 0);
}
const source = args[0];
const top = Number(args[args.indexOf("--top") + 1]) || 10;
const outFlag = args.indexOf("--out");
const outFile = outFlag >= 0 ? resolve(args[outFlag + 1]) : null;

const log = (msg) => console.log(`[shotforge] ${msg}`);
const t0 = Date.now();
try {
  const { result } = await runRank({
    source,
    workRoot: resolve("."),
    top,
    onStage: (stage, note) => log(`stage: ${stage}${note ? ` — ${note}` : ""}`),
    log,
  });

  if (outFile) {
    mkdirSync(resolve(outFile, ".."), { recursive: true });
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    log(`wrote ${outFile}`);
  }

  console.log("\n=== ShotForge ranking ===");
  for (const c of result.clips) {
    console.log(
      `#${c.rank} ${String(c.score).padStart(3)}  ${fmt(c.start)}→${fmt(c.end)} (${c.durationSec.toFixed(0)}s) [${c.kind}] ${c.hook}`,
    );
  }
  console.log(`\nwall time: ${(result.totalWallSec / 1000).toFixed(1)}s`);
} catch (err) {
  console.error(`[shotforge] FAILED: ${err.message}`);
  process.exit(1);
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
