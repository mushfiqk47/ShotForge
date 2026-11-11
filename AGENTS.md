# AGENTS.md

Instructions for AI coding agents working in this repository.

ShotForge is a local-first OpusClip alternative: Node 24 ESM, **zero npm dependencies**, vanilla web UI with no build step. Pipeline: whisper.cpp CUDA → shot detect → candidates → heuristic + Ollama (lfm3 / lfm3-vl / lfm3-omni) ensemble → ffmpeg NVENC render with libass karaoke captions. Everything runs on the user's machine; nothing leaves it.

## Behavioral guidelines (Karpathy)

Bias toward caution over speed; for trivial tasks use judgment.

### 1. Think before coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, ask.

### 2. Simplicity first
- Minimum code that solves the problem. Nothing speculative.
- No features, abstractions, or configurability beyond what was asked.
- No error handling for impossible scenarios.
- If you wrote 200 lines and it could be 50, rewrite it.

### 3. Surgical changes
- Touch only what the task requires. Match the surrounding style (JSDoc headers on modules, plain functions, ESM imports).
- Don't "improve" adjacent code, comments, or formatting. Don't refactor what isn't broken.
- Notice unrelated dead code? Mention it — don't delete it.
- Remove only the imports/variables/functions *your* change made unused.
- Every changed line should trace directly to the request.

### 4. Goal-driven execution
- Turn tasks into verifiable goals: "fix the bug" → reproduce it first, then make the reproduction pass.
- For multi-step work, state a plan with a verify check per step, then loop until verified.
- Report results honestly: if a check failed, say so with the output.

## Project rules

- **Node 24** (`>=22`): `server/src` is ESM (`"type": "module"`). No new npm dependencies without asking — the server uses only `node:` built-ins.
- **GPU is 6 GB** (RTX 4050): all Ollama calls go sequentially, `think:false`, JSON schema via `format`, `keep_alive:0`, explicit `unloadModel` between phases. Never parallelize model calls.
- **Output is always 9:16** (1080×1920). Do not add ratio options; render/preview code ignores client ratios by design.
- **Caption sync invariants**: word timings are clip-relative (rebased to `finalStart`); `guardWords` drops pre-trim words (never clamps to 0); karaoke `\k` ≥ 12cs; lines never overlap (see `captions.js`).
- **Translation invariant**: `translateWords` preserves word count and timings exactly — karaoke alignment depends on it.
- **Gotchas already paid for**: lfm3 returns wrong counts on big batches (keep batches ≤ 14, schema-enforce counts); ASS previews must keep PlayRes 1080×1920; ffmpeg runs with `cwd=workDir` so libass paths stay relative; loudnorm needs `-ar 48000` after it; work-dir id = `base64url(absPath).slice(-60)` — CLI and server must hash the same path.
- **Verify before claiming done**: `node --check` every touched file; exercise the changed path (render a clip, hit the endpoint) rather than declaring success from code reading. Test scripts and fixtures live outside the repo (`$TEMP`), never in it.
- **Don't commit** unless explicitly asked; `.work/`, `downloads/`, `uploads/`, `assets/.preview-cache/`, `graphify-out/` stay local.
