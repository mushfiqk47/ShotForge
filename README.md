# ShotForge

**Perfect shots from any video — 100% local, $0/month.**

ShotForge is a local-first alternative to cloud clip generators (OpusClip & co). Give it any video — a podcast, interview, vlog, or even footage with no dialogue — and it finds the moments worth posting, reframes them vertical, burns styled karaoke captions, and renders ready-to-post shorts. Nothing ever leaves your machine.

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
                          ▼
        RENDER: face/motion-aware 9:16 reframe → libass karaoke captions
                → h264_nvenc 1080×1920
```

- **Transcription**: whisper.cpp (CUDA pack) with word-level timestamps
- **Ranking**: hybrid heuristic + LLM ensemble — every clip carries its score *and* the reason
- **Captions**: 12 style presets (Beast Pop, Hormozi, Karaoke, TikTok Clean, Neon, Minimal, Typewriter, Emoji, Gradient, Pill Box, Cinematic, Urdu Nastaliq) — WYSIWYG previews use the real render pipeline
- **Controls**: caption vertical position + scale sliders, per-clip re-render
- **Camera analysis**: lfm3-omni looks at frame sequences to judge framing and suggest tighter cuts

## Requirements (bring your own, nothing is auto-downloaded)

- Node.js ≥ 22
- `ffmpeg` / `ffprobe` on PATH (libass + NVENC build)
- A whisper.cpp CUDA (or CPU) build with a GGML model, plus Ollama serving a text, vision and omni model
- Optional: yt-dlp for URL imports

Point `server/src/paths.js` at your binaries/models if they live somewhere else.

## Run

```bash
npm start            # web studio → http://localhost:8899
npm run rank -- <video-or-url>   # CLI: ranked moments JSON
npm run render -- <video> --index 1   # CLI: render one clip
```

## Layout

```
server/src/index.js        HTTP + SSE job server (port 8899)
server/src/pipeline/       ingest → audio → transcribe → detect → candidates
                           → score-heuristic → score-llm → ensemble → omni
                           → reframe → captions → render
server/src/cli-rank.js     CLI ranking entry
server/src/cli-render.js   CLI render entry
web/                       vanilla-JS studio UI (no build step)
assets/fonts/              OFL-licensed caption fonts
```

## Privacy

Everything runs locally: transcription, ranking, frame analysis, rendering. There is no cloud call, no API key, no telemetry. yt-dlp and whisper models are the only external downloads, and only when you ask for them.

## License

MIT — see [LICENSE](LICENSE).
