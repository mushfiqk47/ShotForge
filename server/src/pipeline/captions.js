/**
 * Word-level captions as ASS (libass burn-in) — 12 style packs.
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
  "beast-pop": {
    font: "Anton", size: 96, maxWords: 2, uppercase: true, karaoke: true,
    fill: "&H0000D7FF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 8,
    shadow: 2, box: false, align: 2, positionPct: 22,
  },
  hormozi: {
    font: "Montserrat", size: 80, maxWords: 3, uppercase: true, karaoke: true,
    fill: "&H0000D7FF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 5,
    shadow: 1, box: false, align: 2, positionPct: 24,
  },
  "karaoke-pop": {
    font: "Inter", size: 64, maxWords: 6, uppercase: false, karaoke: true,
    fill: "&H0000FFC8", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 5,
    shadow: 1, box: false, align: 2, positionPct: 20,
  },
  "tiktok-clean": {
    font: "Inter", size: 48, maxWords: 7, uppercase: false, karaoke: false,
    fill: "&H00FFFFFF", base: "&H00FFFFFF", outline: "&H90121A20", outlineWidth: 10,
    shadow: 0, box: true, align: 2, positionPct: 16,
  },
  "neon-gaming": {
    font: "Oswald", size: 74, maxWords: 4, uppercase: true, karaoke: true,
    fill: "&H0050FF50", base: "&H00FFFFFF", outline: "&H00FF5096", outlineWidth: 4,
    shadow: 3, box: false, align: 2, positionPct: 26, blur: 4,
  },
  "netflix-minimal": {
    font: "Inter", size: 44, maxWords: 8, uppercase: false, karaoke: false,
    fill: "&H00FFFFFF", base: "&H00FFFFFF", outline: "&HA0141414", outlineWidth: 9,
    shadow: 0, box: true, align: 2, positionPct: 14,
  },
  typewriter: {
    font: "JetBrainsMono", size: 52, maxWords: 6, uppercase: false, karaoke: false,
    typewriter: true,
    fill: "&H0000FFC8", base: "&H00FFFFFF", outline: "&H00141820", outlineWidth: 12,
    shadow: 0, box: true, align: 2, positionPct: 18,
  },
  "emoji-pop": {
    font: "Montserrat", size: 76, maxWords: 3, uppercase: true, karaoke: true,
    emoji: true,
    fill: "&H0000D7FF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 6,
    shadow: 1, box: false, align: 2, positionPct: 24,
  },
  "gradient-pop": {
    font: "Montserrat", size: 78, maxWords: 3, uppercase: true, karaoke: true,
    gradient: ["&H0000D7FF", "&H0064FF64", "&H00E09EFF"], // yellow → green → pink cycle
    fill: "&H0000D7FF", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 6,
    shadow: 1, box: false, align: 2, positionPct: 24,
  },
  "pill-box": {
    font: "Inter", size: 60, maxWords: 4, uppercase: false, karaoke: true,
    fill: "&H0000D7FF", base: "&H00FFFFFF", outline: "&H00141414", outlineWidth: 12,
    shadow: 2, box: true, align: 2, positionPct: 22,
  },
  cinematic: {
    font: "Playfair Display", size: 56, maxWords: 7, uppercase: false, karaoke: false,
    italic: true,
    fill: "&H00BCE8FA", base: "&H00FFFFFF", outline: "&H00000000", outlineWidth: 3,
    shadow: 3, box: false, align: 2, positionPct: 16,
  },
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
  if (language === "hi") return "karaoke-pop";
  return "bold-pop" in PACKS ? "bold-pop" : "beast-pop";
}

/**
 * @param {Array<{start:number,end:number,word:string}>} words  clip-relative seconds
 * @param {{pack?:string, language?:string, width?:number, height?:number,
 *          positionPct?:number, scalePct?:number}} opts
 * @returns {string} ASS document
 */
export function buildAss(words, opts = {}) {
  const {
    pack = "beast-pop",
    language = "en",
    width = 1080,
    height = 1920,
    positionPct = null,
    scalePct = 1,
  } = opts;
  const style = PACKS[pack] ?? PACKS["beast-pop"];
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
    `Style: Cap,${fontFamily},${fontSize},${style.fill},${style.base},${style.outline},&H64000000,1,${style.italic ? 1 : 0},0,0,100,100,0,0,${style.box ? 3 : 1},${style.outlineWidth},${style.shadow},${style.align},80,80,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  let events;
  if (style.typewriter) events = typewriterEvents(words, style, isRtl);
  else events = lineEvents(words, style, isRtl);
  return [...header, ...events].join("\n");
}

function lineEvents(words, style, isRtl) {
  const lines = groupLines(words, style.maxWords, style.rtl || isRtl);
  return lines.map((line) => {
    const start = line[0].start;
    const end = line[line.length - 1].end;
    const body = style.karaoke
      ? line
          .map((w, i) => {
            const durCs = Math.max(6, Math.round((w.end - w.start) * 100));
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
  // Each word appears when spoken and stays: one Dialogue per word,
  // spanning from that word's start to the end of its line.
  const events = [];
  const lines = groupLines(words, style.maxWords, isRtl);
  for (const line of lines) {
    const lineEnd = line[line.length - 1].end;
    line.forEach((w, i) => {
      const text = line.slice(0, i + 1).map((x) => x.word).join(" ");
      events.push(
        `Dialogue: 0,${assTime(w.start)},${assTime(lineEnd)},Cap,,0,0,0,,${text}`,
      );
    });
  }
  return events;
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
