/**
 * Word-level captions as ASS (libass burn-in) — 14 CapCut-style presets.
 * Each pack is a distinct effect: no two share fill colour + mechanic + font.
 *
 * Karaoke mechanics (libass \k): text is shown in SecondaryColour before its
 * timestamp and fills to PrimaryColour as it is spoken. So per pack:
 *   `base`  = SecondaryColour (unspoken)     `fill` = PrimaryColour (spoken)
 *
 * Every pack supports:
 *   positionPct (0 = bottom edge … 100 = top) → MarginV
 *   scalePct    (0.6 … 1.6) → fontSize
 * Fonts are OFL-licensed and ship in assets/fonts.
 */

export const PACKS = {
  // Clean white bold sans, black outline — no karaoke.
  classic: {
    font: "Inter", size: 60, maxWords: 6, uppercase: false, karaoke: false,
    fill: "&H00FFFFFF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 4,
    shadow: 1, box: false, align: 2, positionPct: 20,
  },
  // CapCut signature: white bold caps, the SPOKEN word fills yellow.
  highlight: {
    font: "Anton", size: 92, maxWords: 3, uppercase: true, karaoke: true,
    fill: "&H0000D7FF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 8,
    shadow: 2, box: false, align: 2, positionPct: 22,
  },
  // The viral "Most Readable": all-yellow bold caps, spoken word pops white.
  "yellow-pop": {
    font: "Anton", size: 88, maxWords: 3, uppercase: true, karaoke: true,
    fill: "&H00FFFFFF", base: "&H0000D7FF", outline: "&H00000000", outlineWidth: 8,
    shadow: 2, box: false, align: 2, positionPct: 22,
  },
  // Classic two-colour karaoke: unspoken white, spoken lime, more words per line.
  karaoke: {
    font: "Inter", size: 56, maxWords: 6, uppercase: false, karaoke: true,
    fill: "&H0000FFC8", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 4,
    shadow: 1, box: false, align: 2, positionPct: 20,
  },
  // White text on a solid black box — no karaoke.
  box: {
    font: "Inter", size: 52, maxWords: 5, uppercase: false, karaoke: false,
    fill: "&H00FFFFFF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 12,
    shadow: 0, box: true, align: 2, positionPct: 18,
  },
  // Words appear one at a time and stay.
  typewriter: {
    font: "JetBrainsMono", size: 52, maxWords: 6, uppercase: false, karaoke: false,
    typewriter: true,
    fill: "&H0000FFC8", base: "&H00FFFFFF", outline: "&H00141820", outlineWidth: 12,
    shadow: 0, box: true, align: 2, positionPct: 18,
  },
  // White karaoke text filling cyan, soft blur glow, neon accent outline.
  glow: {
    font: "Oswald", size: 64, maxWords: 4, uppercase: true, karaoke: true,
    fill: "&H00FFE500", base: "&H00FFFFFF", outline: "&H00FF5096", outlineWidth: 4,
    shadow: 3, box: false, align: 2, positionPct: 24, blur: 4,
  },
  // Spoken word fills red — same punch as highlight, opposite energy.
  impact: {
    font: "Anton", size: 92, maxWords: 3, uppercase: true, karaoke: true,
    fill: "&H002A2AFF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 8,
    shadow: 2, box: false, align: 2, positionPct: 22,
  },
  // Every word cycles a bright colour as it's spoken.
  rainbow: {
    font: "Montserrat", size: 72, maxWords: 3, uppercase: true, karaoke: true,
    gradient: ["&H002A2AFF", "&H0000D7FF", "&H0030FF8E", "&H00FF5096"],
    fill: "&H00FFFFFF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 5,
    shadow: 1, box: false, align: 2, positionPct: 22,
  },
  // Karaoke with contextual emoji appended to the first matching word.
  emoji: {
    font: "Inter", size: 60, maxWords: 4, uppercase: true, karaoke: true, emoji: true,
    fill: "&H000A9FFF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 4,
    shadow: 1, box: false, align: 2, positionPct: 20,
  },
  // Letter-spaced caps, no karaoke — fashion/edititorial lower-third.
  editorial: {
    font: "Inter", size: 54, maxWords: 4, uppercase: true, karaoke: false, spacing: 6,
    fill: "&H00FFFFFF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 3,
    shadow: 1, box: false, align: 2, positionPct: 18,
  },
  // Spoken word fills pink and every word is underlined.
  marker: {
    font: "Montserrat", size: 64, maxWords: 4, uppercase: false, karaoke: true,
    underline: true,
    fill: "&H005F37FF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 4,
    shadow: 1, box: false, align: 2, positionPct: 20,
  },
  // Italic serif, soft shadow, elegant.
  fancy: {
    font: "Playfair Display", size: 56, maxWords: 7, uppercase: false, karaoke: false,
    italic: true,
    fill: "&H00BCE8FA", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 3,
    shadow: 3, box: false, align: 2, positionPct: 20,
  },
  // Urdu Nastaliq — essential for Urdu content.
  "nastaliq-urdu": {
    font: "Noto Nastaliq Urdu", size: 64, maxWords: 4, uppercase: false, karaoke: true,
    rtl: true,
    fill: "&H0080D0FF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 4,
    shadow: 2, box: false, align: 2, positionPct: 28, lineHeight: 1.5,
  },
};

const RTL_LANGS = new Set(["ur", "ar", "fa", "he"]);
const EMOJI_MAP = [
  [/\bmoney|dollars?|k\b|\$\d|paid|rich/i, "💰"],
  [/\bcrazy|insane|unbelievable|shocking|mind/i, "🤯"],
  [/\blove|heart|beautiful/i, "❤️"],
  [/\bfast|instant|seconds?|minutes?/i, "⚡"],
  [/\bsecret|nobody|hidden/i, "🤫"],
  [/\bbest|perfect|number one|#1/i, "🔥"],
  [/\bstop|never|wrong|mistake/i, "🚫"],
  [/\bgrow|double|doubled|increased/i, "📈"],
  [/\blaugh|funny|hilarious/i, "😂"],
  [/\bwatch|look|see this/i, "👀"],
];

/** Pick pack for a language when the caller doesn't force one. */
export function packForLanguage(language, requested) {
  if (requested && PACKS[requested]) return requested;
  if (language === "ur") return "nastaliq-urdu";
  if (language === "hi") return "karaoke";
  return "highlight";
}

/**
 * @param {Array<{start:number,end:number,word:string}>} words  clip-relative seconds
 * @param {{pack?:string, language?:string, width?:number, height?:number,
 *          positionPct?:number, scalePct?:number}} opts
 * @returns {string} ASS document
 */
export function buildAss(words, opts = {}) {
  const {
    pack = "highlight",
    language = "en",
    width = 1080,
    height = 1920,
    positionPct = null,
    scalePct = 1,
  } = opts;
  const style = PACKS[pack] ?? PACKS["highlight"];
  const isRtl = style.rtl || RTL_LANGS.has(language);
  const fontFamily = isRtl && language === "ur" ? "Noto Nastaliq Urdu" : style.font;
  const fontSize = Math.round(style.size * scalePct);
  const posPct = positionPct ?? style.positionPct ?? 20;
  const marginV = Math.round(height * Math.min(0.92, Math.max(0.02, posPct / 100)));

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${fontFamily},${fontSize},${style.fill},${style.base},${style.outline},&H64000000,1,${style.italic ? 1 : 0},${style.underline ? 1 : 0},0,100,100,${style.spacing ?? 0},0,${style.box ? 3 : 1},${style.outlineWidth},${style.shadow},${style.align},80,80,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  let events;
  const safeWords = guardWords(words);
  if (style.typewriter) events = typewriterEvents(safeWords, style, isRtl);
  else events = lineEvents(safeWords, style, isRtl);
  return [...header, ...events].join("\n");
}

/**
 * Defense-in-depth for rebased word lists: words clipped to a trim window can
 * arrive with end <= 0.02 (they fell before the trim point) — those must be
 * dropped, never clamped to 0, which would pile trimmed-out words at t=0 and
 * desync captions. Words straddling the clip start just get start clamped.
 */
function guardWords(words) {
  return (words ?? [])
    .filter((w) => w && Number.isFinite(w.end) && w.end > 0.02)
    .map((w) => ({
      ...w,
      start: Math.max(0, w.start ?? 0),
      end: Math.max(Math.max(0, w.start ?? 0), w.end),
    }));
}

function lineEvents(words, style, isRtl) {
  const lines = withLinger(groupLines(words, style.maxWords, style.rtl || isRtl));
  return lines.map(({ words: line, start, end }) => {
    const body = style.karaoke
      ? line
          .map((w, i) => {
            const durCs = Math.max(12, Math.round((w.end - w.start) * 100));
            const word = decorate(w.word, style, i);
            const prefix = style.gradient
              ? `{\\1c${style.gradient[i % style.gradient.length]}}`
              : style.blur
                ? "{\\blur4}"
                : "";
            const suffix = style.blur ? "{\\blur0}" : "";
            return `${prefix}{\\k${durCs}}${word}${suffix}`;
          })
          .join(" ")
      : line.map((w) => decorate(w.word, style, 0)).join(" ");
    return `Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${body}`;
  });
}

function typewriterEvents(words, style, isRtl) {
  // Each word appears when spoken and stays: one Dialogue per cumulative
  // text, ending when the NEXT word starts (so events replace each other —
  // letting them run to lineEnd overlapped and libass stacked them).
  const events = [];
  const lines = withLinger(groupLines(words, style.maxWords, isRtl));
  for (const { words: line, end: lineEnd } of lines) {
    line.forEach((w, i) => {
      const text = line.slice(0, i + 1).map((x) => x.word).join(" ");
      const next = line[i + 1];
      const end = next ? Math.max(next.start, w.start + 0.05) : lineEnd;
      events.push(
        `Dialogue: 0,${assTime(w.start)},${assTime(end)},Cap,,0,0,0,,${text}`,
      );
    });
  }
  return events;
}

/**
 * Anti-flicker: a spoken line lingers briefly past its last word instead of
 * vanishing between words/lines — but never into the next line's start, so
 * events never overlap.
 */
function withLinger(lines) {
  return lines.map((line, i) => {
    const lastEnd = line[line.length - 1].end;
    const nextStart = i + 1 < lines.length ? lines[i + 1][0].start : Infinity;
    const cap = nextStart - 0.05;
    const end = Math.max(
      Math.min(line[0].start + 0.12, cap), // minimum visible sliver when the gap allows
      Math.min(cap, lastEnd + 1.2),        // anti-flicker linger
      line[0].start,                       // never before the line's own start
    );
    return { words: line, start: line[0].start, end };
  });
}

function decorate(word, style, index) {
  let out = style.uppercase ? word.toUpperCase() : word;
  if (style.emoji && index === 0) {
    for (const [re, emoji] of EMOJI_MAP) {
      if (re.test(word)) {
        out = `${out} ${emoji}`;
        break;
      }
    }
  }
  return out;
}

function groupLines(words, maxWords, isRtl) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    if (
      cur.length >= maxWords ||
      (cur.length && w.start - cur[cur.length - 1].end > 0.8)
    ) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return isRtl ? lines : lines; // libass+HarfBuzz handles RTL shaping per line
}

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
