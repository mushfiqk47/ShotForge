import { dedupe } from "./candidates.js";

/**
 * Final ensemble: 0-100 score with a transparent reason, from three judges:
 *   heuristic (signals + duration fit), lfm3 text re-rank, lfm3-vl frames.
 * Weights shift toward vision when there is no usable transcript.
 */
export function ensemble(candidates, { top = 10 } = {}) {
  for (const c of candidates) {
    const heuristic = Math.round((c.heuristic ?? 0) * 100);
    const text = c.llm?.score ?? null;
    const vision = c.vision?.score ?? null;

    let score;
    if (c.kind === "speech" && text !== null) {
      score = 0.3 * heuristic + 0.5 * text + 0.2 * (vision ?? 50);
    } else if (c.kind === "visual") {
      score = 0.25 * heuristic + 0.15 * (text ?? heuristic) + 0.6 * (vision ?? 50);
    } else {
      score = 0.6 * heuristic + 0.4 * (text ?? 50);
    }

    // LLM-suggested tighter trim, if it stays inside the window.
    let start = c.start;
    let end = c.end;
    if (c.llm?.keepStart !== null && c.llm?.keepEnd !== null) {
      const s = Math.max(c.start, c.llm.keepStart);
      const e = Math.min(c.end, c.llm.keepEnd);
      if (e - s >= 10) {
        start = s;
        end = e;
      }
    }

    c.score = Math.max(0, Math.min(100, Math.round(score)));
    c.finalStart = round2(start);
    c.finalEnd = round2(end);
    c.durationSec = round2(end - start);
    c.hook = c.llm?.hook || firstWords(c.text, 10);
    c.reason = buildReason(c);
  }

  const ranked = dedupe(candidates).sort((a, b) => b.score - a.score);
  return ranked.slice(0, top);
}

function buildReason(c) {
  const parts = [];
  if (c.llm?.reason) parts.push(c.llm.reason);
  const signals = (c.signals ?? []).slice(0, 3).join(", ");
  if (signals) parts.push(`detectors: ${signals}`);
  if (c.vision?.description) parts.push(`visuals: ${c.vision.description}`);
  return parts.join(" — ").slice(0, 400);
}

function firstWords(text, n) {
  if (!text) return "";
  return text.split(/\s+/).slice(0, n).join(" ");
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
