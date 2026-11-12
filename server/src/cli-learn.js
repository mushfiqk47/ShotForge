#!/usr/bin/env node
/**
 * ShotForge CLI: learn ensemble weights from your own platform analytics.
 *   node server/src/cli-learn.js <analytics.csv> <rank.json> [--out shotforge-weights.json]
 *
 * analytics.csv — exported from TikTok/YouTube (header row required):
 *   title,views[,likes]
 * rank.json — a ranking written by cli-rank.js / runRank (clips[].meta.title,
 *   clips[].hook, clips[].heuristic / .llm / .vision).
 *
 * Each CSV row is fuzzy-matched to the clip whose meta.title or hook is most
 * similar (dice coefficient on lowercase-alphanumeric bigrams, substring bonus,
 * ≥ 0.3 counts as a match). For matched clips with views, Pearson correlates
 * each available factor (heuristic / llm / vision) with log(views); the
 * ensemble's speech blend weights (0.3 heuristic / 0.5 llm / 0.2 vision per
 * ensemble.js) are nudged ±0.15 per correlation unit, clamped to [0.05, 0.9],
 * renormalized to sum ≈ 1 and written as:
 *   { "weights": { "heuristic": w1, "llm": w2, "vision": w3 },
 *     "samples": matchedCount, "generated": ISO date }
 *
 * NOTE (wiring): ensemble.js does not accept a weights option yet — this file
 * is written so the ensemble can consume shotforge-weights.json once it
 * exposes one (weights keyed heuristic/llm/vision, speech blend semantics).
 * Until then the file is informational output only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length < 2 || args[0] === "--help") {
  console.log("usage: node cli-learn.js <analytics.csv> <rank.json> [--out shotforge-weights.json]");
  process.exit(args.length < 2 ? 1 : 0);
}
const csvPath = resolve(args[0]);
const rankPath = resolve(args[1]);
const outFlag = args.indexOf("--out");
const outPath = outFlag >= 0 ? resolve(args[outFlag + 1]) : resolve("shotforge-weights.json");

const BASE = { heuristic: 0.3, llm: 0.5, vision: 0.2 }; // ensemble.js speech blend
const NUDGE = 0.15;
const MATCH_THRESHOLD = 0.3;

const rank = JSON.parse(readFileSync(rankPath, "utf8"));
const rows = parseCsv(readFileSync(csvPath, "utf8"));

const clips = rank.clips ?? [];
const matched = [];
for (const row of rows) {
  const normTitle = norm(row.title);
  if (!normTitle) continue;
  let best = null;
  for (const clip of clips) {
    const targets = [clip.meta?.title, clip.hook].filter(Boolean).map(norm);
    const sim = Math.max(0, ...targets.map((t) => similarity(normTitle, t)));
    if (sim >= MATCH_THRESHOLD && (!best || sim > best.sim)) best = { sim, clip };
  }
  if (best) matched.push({ views: row.views, clip: best.clip });
}
const usable = matched.filter((m) => m.views > 0);
console.log(`[shotforge] ${rows.length} csv rows → ${matched.length} matched (${usable.length} with views)`);

const weights = { ...BASE };
if (usable.length < 3) {
  console.log("[shotforge] fewer than 3 matched samples — correlations are noise, weights left at base");
} else {
  const logViews = usable.map((m) => Math.log(m.views));
  for (const factor of Object.keys(BASE)) {
    const xs = usable.map((m) => m.clip[factor]).filter((v) => v !== null && v !== undefined);
    if (xs.length !== usable.length) continue; // factor missing on some clips — no nudge
    const r = pearson(xs, logViews);
    if (r === null) continue;
    weights[factor] = Math.min(0.9, Math.max(0.05, weights[factor] + NUDGE * r));
    console.log(`[shotforge] ${factor}: r=${r.toFixed(2)} → weight ${weights[factor].toFixed(2)}`);
  }
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(weights)) weights[k] = Math.round((weights[k] / sum) * 1000) / 1000;
}

const out = { weights, samples: matched.length, generated: new Date().toISOString() };
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`[shotforge] wrote ${outPath}\n${JSON.stringify(weights)}`);

/** Parse a small CSV with a header row: title,views[,likes]. Handles quoted fields. */
function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = parseCsvLine(header).map((c) => c.trim().toLowerCase());
  const out = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    const get = (name) => cells[cols.indexOf(name)] ?? "";
    const views = Number(String(get("views")).replace(/[",\s]/g, ""));
    out.push({ title: get("title").trim(), views: Number.isFinite(views) ? views : 0 });
  }
  return out.filter((r) => r.title);
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Lowercase alphanumerics only — the comparison space for fuzzy titles. */
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Dice coefficient on character bigrams, with a substring containment bonus. */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return Math.max(0.5, dice(a, b));
  return dice(a, b);
}

function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = {};
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2);
    counts[g] = (counts[g] ?? 0) + 1;
  }
  let inter = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2);
    if (counts[g] > 0) { inter += 1; counts[g] -= 1; }
  }
  return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

/** Pearson correlation; null when either side has zero variance. */
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}
