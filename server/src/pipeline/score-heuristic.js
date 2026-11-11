/**
 * Fast on-device pre-score (0..1) before the LLM ensemble.
 * Mirrors the proven ClipShlip signal weights, extended with visual signals.
 */
const WEIGHTS = {
  "question-answer": 0.25,
  "reaction-marker": 0.2,
  "energy-peak": 0.2,
  "loud-moment": 0.15,
  "quiet-cinematic": 0.1,
  "pause-bounded": 0.15,
  "speaker-change": 0.1,
  "emphasis-run": 0.1,
  "shot-fit": 0.12,
};

export function heuristicScore(candidate) {
  let score = 0;
  for (const signal of candidate.signals ?? []) {
    score += WEIGHTS[signal] ?? 0;
  }
  // Duration sweet spot: gaussian-ish around 28s, hard falloff past 55s.
  const len = candidate.end - candidate.start;
  const fit = len <= 55 ? Math.exp(-Math.pow((len - 28) / 22, 2)) : 0.35;
  score += fit * 0.15;
  return Math.min(1, score);
}
