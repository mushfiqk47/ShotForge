/**
 * Caption translation / transliteration — ClipShlip's headline feature.
 * Maps a clip's word array word-for-word into the target script
 * (roman-urdu, urdu, hindi, english) while keeping every word's timing
 * exactly, so the existing karaoke caption pipeline renders the translated
 * text untouched.
 *
 * Strategy: batch the words (~40 per lfm3 call), ask for exactly one output
 * word per input word, validate the count, retry twice with a stricter
 * reminder, and fall back to the original batch on final failure —
 * translation never fails the pipeline.
 */
import { PATHS } from "../paths.js";
import { chatJson } from "../ollama.js";

export const TRANSLATE_MODES = ["none", "roman-urdu", "urdu", "hindi", "english"];

// lfm3 (1.7B) keeps 1:1 word counts only for small batches — at ~40 inputs it
// drifts into phrase translation and returns the wrong count every time.
// 14 is the largest batch size observed to comply reliably.
const BATCH_SIZE = 14;

/** Per-batch schema: minItems/maxItems force exactly one word per input. */
function schemaFor(count) {
  return {
    type: "object",
    properties: {
      words: { type: "array", items: { type: "string" }, minItems: count, maxItems: count },
    },
    required: ["words"],
  };
}

const MODES = {
  "roman-urdu": {
    instruction:
      "Translate the caption words into ROMAN URDU (Urdu written in Latin letters): common words become their Urdu word in lowercase Latin letters, proper nouns stay unchanged.",
    example: '["how","are","you"] → {"words":["kaise","ho","aap"]}',
  },
  urdu: {
    instruction:
      "Translate the caption words into URDU SCRIPT (اردو, right-to-left): common words become their Urdu word in Urdu script, proper nouns stay in Latin letters.",
    example: '["how","are","you"] → {"words":["کیسے","ہو","آپ"]}',
  },
  hindi: {
    instruction:
      "Translate the caption words into HINDI (Devanagari script), choosing the closest single Hindi word for each input.",
    example: '["how","are","you"] → {"words":["कैसे","हो","आप"]}',
  },
  english: {
    instruction:
      "Translate the caption words into ENGLISH, choosing the closest single English word for each input.",
    example: '["kaise","ho","aap"] → {"words":["how","are","you"]}',
  },
};

/**
 * Translate a clip's caption words into the target script.
 * @param {Array<{start:number,end:number,word:string}>} words  clip-relative seconds
 * @param {string} mode  one of TRANSLATE_MODES ("none" returns the input unchanged)
 * @param {(line:string)=>void} [log]
 * @returns {Promise<Array<{start:number,end:number,word:string}>>} NEW array, identical start/end
 */
export async function translateWords(words, mode, log = () => {}) {
  if (!Array.isArray(words) || words.length === 0 || !mode || mode === "none") {
    return words;
  }
  const target = MODES[mode] ? mode : "english";
  const out = [];
  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const mapped = await translateBatch(batch, target, log);
    for (let j = 0; j < batch.length; j += 1) {
      out.push({ start: batch[j].start, end: batch[j].end, word: mapped[j] });
    }
  }
  return out;
}

/** Map one batch to the target script; falls back to the original words. */
async function translateBatch(batch, mode, log) {
  const original = batch.map((w) => w.word);
  const inputs = batch.map((w) => {
    const stripped = w.word.replace(/[.,!?;:"'…،؟]+$/, "").trim();
    return stripped || w.word; // keep 1:1 positions even for punctuation-only tokens
  });
  const n = inputs.length;

  // Initial attempt + up to 2 retries with a stricter count reminder.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const parsed = await chatJson({
        model: PATHS.models.text,
        schema: schemaFor(n),
        prompt: batchPrompt(inputs, mode, attempt > 0),
        options: { temperature: 0.4, num_predict: 400 },
        timeoutMs: 120_000,
        retries: 0, // this loop owns retries so the count stays bounded
        log,
      });
      const words = Array.isArray(parsed.words) ? parsed.words : null;
      if (words && words.length === n) {
        return words.map((w, i) => String(w ?? "").trim() || original[i]);
      }
      log(`translate: wrong word count (${words?.length ?? 0} ≠ ${n}) — attempt ${attempt + 1}/3`);
    } catch (err) {
      log(`translate: call failed (${err.message}) — attempt ${attempt + 1}/3`);
    }
  }
  return original; // final failure: keep the original words for this batch
}

function batchPrompt(inputs, mode, strict) {
  const spec = MODES[mode];
  return [
    "Translate this word array into the target language/script, one word per position, in the same order.",
    spec.instruction,
    "Do NOT copy the input words (except proper nouns). No punctuation, no quotes, no explanations. Never merge, split, add or drop words.",
    strict
      ? `STRICT: your previous reply had the wrong number of words. The output array MUST contain exactly ${inputs.length} words — one per input word.`
      : "",
    `Example: ${spec.example}`,
    `Input: ${JSON.stringify(inputs)}`,
    `Respond with JSON only: {"words":[...]} with exactly ${inputs.length} translated words.`,
  ]
    .filter(Boolean)
    .join("\n");
}
