# AGENTS.md

Instructions for AI coding agents working in this repository.

ShotForge is a local-first OpusClip alternative: Node 24 ESM, **zero npm dependencies**, vanilla web UI with no build step. Pipeline: whisper.cpp CUDA → shot detect → candidates → heuristic + Ollama (lfm3 / lfm3-vl / lfm3-omni) ensemble → ffmpeg NVENC render with libass karaoke captions. Everything runs on the user's machine; nothing leaves it.

## MUST — non-negotiable workflow

1. **Always use ponytail.** Every coding task runs in ponytail mode (the section below) — smallest complete change, ladder order, never-cut list. Only the user saying "stop ponytail" / "normal mode" switches it off.
2. **NEVER read the full project.** At the START of a session (or when touching unfamiliar code), build the map from the graphify graph: read `graphify-out/graph.json` (and `graphify-out/GRAPH_REPORT.md` when present) — nodes, edges, communities tell you what exists and where. Then read ONLY the specific files the task touches. Bulk re-reads of the repo are forbidden; the graph is the index.
3. **Graphify update after EVERY task.** Once a task's edits are done and verified, run `graphify . --update --code-only` from the repo root so the graph stays current for the next session (uses the installed `graphifyy` CLI; `--code-only` because doc semantic extraction has no API key here). If it fails, say so in one line — never skip silently.
4. **NEVER commit or push until the user says so.** No `git commit`, no `git push` without an explicit instruction from the user in the current conversation — not "it's tidy", not "the work is done", only the user's word.
5. **NEVER declare a task complete on your own, and never create completion task lists.** Report what was done, what remains, and any risks — then stop and wait. The user decides when something is complete and what continues next.

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

## Ponytail — lazy senior dev mode (MUST use on every coding task)

The [ponytail skill](C:\Users\mushfiq\.agents\skills\ponytail\SKILL.md) is mandatory here. Solve the whole problem with the least new code; end replies with one line on what you skipped or did not check.

**The ladder, in order — take the first option that fully works:**
1. Does it need to exist? Skip features/options/flexibility nobody asked for (name them in one line if you decline them).
2. Already in this codebase (helper, component, pattern)? Use it the way the surrounding code does.
3. Standard library or platform feature? Use it — a house component beats a native widget.
4. An installed dependency? Use it — never add a dependency for a few lines.
5. One line a reader gets at a glance? One line.
6. Otherwise the minimum code that works.

- Be lazy about the solution, never about the change: finish the callers/tests/fixtures your change breaks.
- No abstractions, wrappers, config, or "for later" code. Deletion beats addition. Keep the codebase's existing structure.
- Bug fix: grep every caller first, fix the root cause once in shared code.
- New non-trivial logic (branch/loop/parser/money/security) leaves one small test or assert-based self-check.
- Deliberate shortcuts get a `shortcut: <limit>, <when to upgrade>` comment.

**Never cut**: validation at trust boundaries, error handling that prevents data loss, security, accessibility, real-hardware calibration, anything the user asked for.

Scope note for this repo: "minimal" means minimal *new code* — the locked UI layout decisions, caption-sync invariants, and 9:16 rules above are existing behavior, not candidates for deletion.

## Project rules

- **Node 24** (`>=22`): `server/src` is ESM (`"type": "module"`). No new npm dependencies without asking — the server uses only `node:` built-ins.
- **GPU is 6 GB** (RTX 4050): all Ollama calls go sequentially, `think:false`, JSON schema via `format`, `keep_alive:0`, explicit `unloadModel` between phases. Never parallelize model calls.
- **Output is always 9:16** (1080×1920). Do not add ratio options; render/preview code ignores client ratios by design.
- **Caption sync invariants**: word timings are clip-relative (rebased to `finalStart`); `guardWords` drops pre-trim words (never clamps to 0); karaoke `\k` ≥ 12cs; lines never overlap (see `captions.js`).
- **Translation invariant**: `translateWords` preserves word count and timings exactly — karaoke alignment depends on it.
- **Gotchas already paid for**: lfm3 returns wrong counts on big batches (keep batches ≤ 14, schema-enforce counts); ASS previews must keep PlayRes 1080×1920; ffmpeg runs with `cwd=workDir` so libass paths stay relative; loudnorm needs `-ar 48000` after it; work-dir id = `base64url(absPath).slice(-60)` — CLI and server must hash the same path.
- **Verify before claiming done**: `node --check` every touched file; exercise the changed path (render a clip, hit the endpoint) rather than declaring success from code reading. Test scripts and fixtures live outside the repo (`$TEMP`), never in it.
- **Don't commit** unless explicitly asked; `.work/`, `downloads/`, `uploads/`, `assets/.preview-cache/`, `graphify-out/` stay local.

## UI rules (web/ — vanilla, no build step)

**Locked layout decisions** (the user chose these element-by-element — do not "improve" them away):
- Stepper row: `01 Source · 02 Typography · 03 Processing · 04 Export`, with Back/Continue at the **far right end** of that row (`margin-left:auto`).
- Step 1 is **upload-only** (click or drag-drop; no path/URL input — CLI keeps path/URL support). No headings/descriptions on steps 1-2.
- Step 2: phone-frame preview LEFT (9:16, 320px) with Position/Scale sliders side-by-side and the Template Preset grid directly **in the right column** — all visible in one viewport.
- Step 4: export tiles **one per row** (1fr), media-left + metadata-right; each tile's video gets an **Expand** pill (top-right) opening a full-size viewer overlay (`.video-modal`, Esc/backdrop closes) — don't remove it.

**Caption presets**: 14 CapCut-style packs (`classic`, `highlight` ← default everywhere, `yellow-pop`, `impact`, `rainbow`, `karaoke`, `emoji`, `marker`, `glow`, `box`, `editorial`, `typewriter`, `fancy`, `nastaliq-urdu`). No two packs may share fill colour + mechanic + font (dedupe rule). Keep every pack's ASS shape (fill = spoken/Primary, base = unspoken/Secondary).

**Design quality floor** (impeccable craft rules — apply to every UI edit):
- Verify by looking at the rendered result (screenshots at shipping sizes), batched — not after each tweak.
- Contrast ≥ 4.5:1 body / ≥ 3:1 large text, in **both** `[data-theme]` variants.
- Theme the browser surfaces: `::selection`, caret-color, scrollbars, focus-visible rings — from the palette.
- Full state coverage: hover, focus, disabled, loading, empty, error — errors name the problem AND the recovery.
- All dynamic DOM writes via `textContent`/`createElement` (XSS-safe). No emoji in UI copy. No gradient text, no kicker/eyebrow labels, no gradient-decoration.
- Mono font (JetBrains Mono) is for data/measurements only; UI copy uses Sora; editorial descriptions may use Source Serif.

## Working with subagents

- Max **2 concurrent agents** (account limit) — queue the third.
- Give each agent explicit file ownership; others read-only. Files shift between turns when the user edits via design mode — **re-read before editing**.
- Element picks from the user's browser may come from a **stale DOM** — diff against the served HTML (`curl localhost:8899/<file>`) before re-applying an edit.
- Web files are served from disk per request: HTML/CSS/JS edits need only a page reload; **server restarts clear the in-memory jobs Map** (finished clips vanish from the Export UI; mp4s stay in `.work/`) — never restart while the user has un-exported results.
- The `llm` pipeline stage takes minutes with no per-candidate progress notes yet; empty `/api/ps` between calls ≠ wedged — confirm with `nvidia-smi` GPU utilization and `/api/jobs` age.
