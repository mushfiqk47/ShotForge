#!/usr/bin/env node
/**
 * ShotForge CLI: mini ranking-eval harness.
 *   node server/src/cli-eval.js <moments.json> <videoPath|URL> [--top N]
 *
 * moments.json — labeled ground-truth moments for ONE video:
 *   [{ "start": 12, "end": 31, "label": "why it's good" }, ...]
 * (start/end in seconds; label is free text shown in the report only.)
 *
 * Runs the real rank pipeline with autoRender:false (no render/meta/thumbs;
 * llm + omni still run — they shape the final windows being measured) and
 * scores each labeled moment against the ranked clips: best IoU, the rank of
 * the best-overlap clip (IoU > 0.3 counts as a hit), hit rate @3/@5/@10,
 * mean best-IoU, MRR. Exits non-zero on failure.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runRank } from "./pipeline/rank.js";

const args = process.argv.slice(2);
if (args.length < 2 || args[0] === "--help") {
  console.log("usage: node cli-eval.js <moments.json> <videoPath|URL> [--top N]");
  process.exit(args.length < 2 ? 1 : 0);
}
const momentsPath = resolve(args[0]);
const source = args[1];
const topFlag = args.indexOf("--top");
const top = topFlag >= 0 ? Number(args[topFlag + 1]) || 10 : 10;

let moments;
try {
  moments = JSON.parse(readFileSync(momentsPath, "utf8"));
} catch (err) {
  console.error(`[shotforge] cannot read moments file: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(moments) || !moments.length || !moments.every((m) => Number.isFinite(m.start) && Number.isFinite(m.end))) {
  console.error('[shotforge] moments must be [{start, end, label?}, ...] — times in seconds');
  process.exit(1);
}

const log = (msg) => console.log(`[shotforge] ${msg}`);
try {
  log(`eval: ${moments.length} labeled moments, top=${top}`);
  const { result } = await runRank({
    source,
    workRoot: resolve("."),
    top,
    autoRender: false,
    onStage: (stage, note) => log(`stage: ${stage}${note ? ` — ${note}` : ""}`),
    log,
  });

  const clips = result.clips;
  const rows = moments.map((m) => {
    let best = { iou: 0, rank: null };
    for (const c of clips) {
      const iou = interOverUnion(m.start, m.end, c.start, c.end);
      if (iou > best.iou) best = { iou, rank: c.rank };
    }
    return { moment: m, best };
  });

  console.log("\n=== ShotForge ranking eval ===");
  console.log("moment               best clip  bestIoU  hit   label");
  for (const { moment: m, best } of rows) {
    const win = `${m.start.toFixed(1)}→${m.end.toFixed(1)}`;
    const hit = best.iou > 0.3;
    console.log(
      `${win.padEnd(20)} #${String(best.rank ?? "-").padEnd(9)} ${best.iou.toFixed(2)}     ${hit ? "yes" : "no"}    ${(m.label ?? "").slice(0, 40)}`,
    );
  }
  const hits = rows.filter((r) => r.best.iou > 0.3);
  const rateAt = (n) => {
    const within = hits.filter((r) => r.best.rank <= n).length;
    return `${((within / rows.length) * 100).toFixed(0)}%`;
  };
  const meanIou = rows.reduce((s, r) => s + r.best.iou, 0) / rows.length;
  const mrr = rows.reduce((s, r) => s + (r.best.rank ? 1 / r.best.rank : 0), 0) / rows.length;
  console.log(`\nmoments: ${rows.length} · hit@3 ${rateAt(3)} · hit@5 ${rateAt(5)} · hit@10 ${rateAt(10)}`);
  console.log(`mean best-IoU ${meanIou.toFixed(2)} · MRR ${mrr.toFixed(2)} · ${clips.length} ranked clips`);
} catch (err) {
  console.error(`[shotforge] FAILED: ${err.message}`);
  process.exit(1);
}

/** Intersection-over-union of two [start, end] windows in seconds. */
function interOverUnion(aStart, aEnd, bStart, bEnd) {
  const inter = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  if (inter <= 0) return 0;
  return inter / ((aEnd - aStart) + (bEnd - bStart) - inter);
}
