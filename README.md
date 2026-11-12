# ShotForge

**Perfect shots from any video — 100% local, $0/month.**

ShotForge is a local-first alternative to cloud clip generators (OpusClip & co). Give it any video — a podcast, interview, vlog, or footage with no dialogue — and it finds the moments worth posting, reframes them vertical, burns styled karaoke captions, and renders ready-to-post shorts. Nothing ever leaves your machine.

## How it works

```
any video ─▶ ffprobe ─▶ 16kHz wav ─▶ whisper.cpp CUDA (word timestamps)
                          │
             scdet shots ─┴─ per-second energy (RMS)
                          ▼
        CANDIDATES: speech windows ∪ visual shots (any genre)
                          ▼
        SCORE ENSEMBLE 0–100 (transparent reasons):
          · on-device heuristics (question-hooks, energy, speakers, pauses)
          · Ollama lfm3 re-rank (JSON-schema: score/hook/reason/trim)
          · lfm3-vl frame scoring + lfm3-omni camera/cut analysis
          · cut snapping to shot boundaries (word-gap guarded)
                          ▼
        PER CLIP: captions (translate · roman-urdu/urdu/hindi/english)
                  title + hashtags + description metadata
                  1080×1920 poster thumbnail
                          ▼
        RENDER: face/motion-aware 9:16 reframe (always 1080×1920)
                → libass karaoke captions → loudnorm -14 LUFS
                → h264_nvenc p6/cq19 → per-render QC checks
```

- **Transcription**: whisper.cpp (CUDA pack) with word-level timestamps; DTW auto-enables if your pack supports it
- **Ranking**: hybrid heuristic + LLM ensemble — every clip carries its score *and* the reason
- **Captions**: 14 CapCut-style presets — Classic, Highlight (spoken word fills yellow, the default), Yellow Pop, Impact (red fill), Rainbow (per-word colours), Karaoke, Emoji Pop (contextual emoji), Marker (pink fill + underline), Glow, Box, Editorial (letter-spaced caps), Typewriter, Fancy, Urdu Nastaliq — with WYSIWYG previews burned by the real render pipeline
- **Translation**: word-for-word caption translation/transliteration that preserves karaoke timing exactly
- **Export**: per-clip title, 5 hashtags, description, poster thumbnail, QC badge; re-render any clip with different typography
- **Camera analysis**: lfm3-omni reads frame sequences to judge framing and tighten cuts

## Requirements (bring your own, nothing is auto-downloaded)

- Node.js ≥ 22
- `ffmpeg` / `ffprobe` on PATH (libass + NVENC build)
- A whisper.cpp CUDA (or CPU) build with a GGML model
- Ollama serving three models: a text model, a vision model, and an omni model
- Optional: yt-dlp for CLI URL imports

Point `server/src/paths.js` at your binaries/models if they live somewhere else. `AGENTS.md` documents the VRAM schedule and invariants agents must keep.

## Run

```bash
npm start                                    # web studio → http://localhost:8899
npm run rank -- <video-or-url> [--top N] [--translate roman-urdu]
npm run render -- <video> --index 1 --pack highlight
```

The web studio is upload-driven: drop a video on step 1, pick a caption language, choose a preset, process, export. Port override: `SHOTFORGE_PORT=9000 node server/src/index.js`.

## Layout

```
server/src/index.js        HTTP + SSE job server (port 8899)
server/src/pipeline/       ingest → audio → transcribe → detect → candidates
                           → score-heuristic → score-llm → ensemble → omni
                           → translate → metadata → thumb → quality
                           → reframe → captions → render
server/src/cli-rank.js     CLI ranking entry
server/src/cli-render.js   CLI render entry
web/                       vanilla-JS studio UI (no build step)
assets/fonts/              OFL-licensed caption fonts
graphify-out/              codebase knowledge graph (gitignored, local)
AGENTS.md                  rules for AI coding agents working on this repo
```

## Privacy

Everything runs locally: transcription, ranking, translation, frame analysis, rendering. There is no cloud call, no API key, no telemetry. yt-dlp and whisper models are the only external downloads, and only when you ask for them.

## License

MIT — see [LICENSE](LICENSE).
