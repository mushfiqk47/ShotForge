/**
 * Unified candidate generation for ANY genre:
 *  - speech windows: sentence-aligned spans snapped to pauses, 15-45s targets
 *  - visual windows: detected shots (merged up to the max length) for
 *    little/no-dialogue content (gaming, sports, b-roll heavy vlogs)
 * Both streams produce {start, end, text, words, signals[], kind}.
 */

const MIN_LEN = 12;
const MAX_LEN = 60;
const PAUSE_GAP = 0.6; // seconds of silence that bounds a natural break

export function speechCandidates(words, segments, energy, durationSec) {
  if (words.length === 0) return [];
  const candidates = [];
  let i = 0;
  while (i < words.length) {
    const start = Math.max(0, words[i].start - 0.15);
    let j = i;
    // Grow until a strong pause / sentence end beyond the min length, or max.
    while (j + 1 < words.length) {
      const next = words[j + 1];
      const gap = next.start - words[j].end;
      const len = next.end - start;
      const sentenceEnd = segments[words[j].segmentId]?.end === words[j].end;
      if (len >= MAX_LEN) break;
      if (
        len >= MIN_LEN &&
        (gap > PAUSE_GAP || (sentenceEnd && len >= 18) || len >= MAX_LEN)
      )
        break;
      j += 1;
    }
    const end = Math.min(durationSec, words[j].end + 0.25);
    if (end - start >= MIN_LEN * 0.6) {
      const slice = words.slice(i, j + 1);
      candidates.push({
        kind: "speech",
        start,
        end,
        text: slice.map((w) => w.word).join(" "),
        words: slice,
        signals: speechSignals(slice, segments, energy, durationSec, start, end),
      });
    }
    // Advance past the pause that bounded this window.
    let k = j + 1;
    while (k < words.length && words[k].start - words[k - 1].end < PAUSE_GAP) k += 1;
    i = k > j ? k : j + 1;
  }
  return candidates;
}

export function visualCandidates(shots, energy, durationSec) {
  const merged = [];
  let cur = null;
  for (const shot of shots) {
    const len = shot.end - shot.start;
    if (cur && cur.end - cur.start + len <= MAX_LEN * 0.8 && len < 8) {
      cur.end = shot.end;
    } else {
      if (cur) merged.push(cur);
      cur = { ...shot };
    }
  }
  if (cur) merged.push(cur);

  return merged
    .filter((s) => s.end - s.start >= 6)
    .slice(0, 40)
    .map((s) => ({
      kind: "visual",
      start: s.start,
      end: Math.min(durationSec, s.end),
      text: "",
      words: [],
      signals: visualSignals(s, energy, durationSec),
    }));
}

function speechSignals(slice, segments, energy, durationSec, start, end) {
  const signals = [];
  const firstWords = slice.slice(0, 12).map((w) => w.word).join(" ").toLowerCase();
  const text = slice.map((w) => w.word).join(" ");

  if (/^(what|why|how|do you|did you|have you|can you|is it|are you|who|when|where|kya|kyun|kaise)\b/.test(firstWords) && slice.length > 20)
    signals.push("question-answer");
  if (/\b(wow|insane|crazy|unbelievable|amazing|shocking|huge|massive|kamaal|kya baat)\b/i.test(text))
    signals.push("reaction-marker");
  if (new Set(slice.map((w) => w.segmentId)).size >= 4)
    signals.push("speaker-change");
  const longPauses = slice.slice(1).filter((w, idx) => w.start - slice[idx].end > 1.2).length;
  if (slice.length > 20 && longPauses <= 2) signals.push("emphasis-run");

  const windowRms = meanRms(energy, start, end);
  const globalRms = meanRms(energy, 0, durationSec);
  if (globalRms > 0 && windowRms > globalRms * 1.15)
    signals.push("energy-peak");
  const startGap = start - (segments[0]?.start ?? 0) >= 0;
  if (startGap) signals.push("pause-bounded");
  return signals;
}

function visualSignals(shot, energy, durationSec) {
  const signals = [];
  const len = shot.end - shot.start;
  if (len >= 10 && len <= 45) signals.push("shot-fit");
  const windowRms = meanRms(energy, shot.start, shot.end);
  const globalRms = meanRms(energy, 0, durationSec);
  if (globalRms > 0 && windowRms > globalRms * 1.3) signals.push("loud-moment");
  if (globalRms > 0 && windowRms < globalRms * 0.35) signals.push("quiet-cinematic");
  return signals;
}

function meanRms(energy, start, end) {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(energy.length, Math.ceil(end));
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i += 1) sum += energy[i];
  return sum / (e - s);
}

/** Dedupe candidates overlapping >60% with a higher-scored one (applied post-scoring). */
export function dedupe(candidates) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of sorted) {
    const clash = kept.find((k) => {
      const overlap = Math.min(k.end, c.end) - Math.max(k.start, c.start);
      return overlap > Math.min(k.end - k.start, c.end - c.start) * 0.6;
    });
    if (!clash) kept.push(c);
  }
  return kept;
}
