#!/usr/bin/env node
/**
 * ShotForge web server (port 8899).
 *   POST /api/rank        {source: "path or URL", top?, translate?} → {jobId}
 *   POST /api/upload      raw body + ?name=file.mp4      → {path}
 *   GET  /api/progress/:jobId   SSE stream (stage/note/log/done/error)
 *   GET  /api/rank/:jobId                               → rank JSON
 *   POST /api/render      {jobId, indexes, pack}         → {outputs}  (always 9:16)
 *   GET  /api/jobs                                      → job list
 *   GET  /media/<base64url-workid>/<file>               → rendered mp4 / thumb / preview
 *   GET  /                                              → web UI
 */
import http from "node:http";
import { resolve, join, normalize } from "node:path";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { runRank, resolveSource } from "./pipeline/rank.js";
import { renderClip } from "./pipeline/render.js";
import { renderStylePreview, renderSamplePreview } from "./pipeline/preview.js";
import { PACKS } from "./pipeline/captions.js";
import { TRANSLATE_MODES } from "./pipeline/translate.js";
import { detectShots, shotsFromCuts } from "./pipeline/detect.js";
import { ingest } from "./pipeline/ingest.js";
import { readFileSync as rf } from "node:fs";

const PORT = Number(process.env.SHOTFORGE_PORT || 8899);
const ROOT = resolve(import.meta.dirname, "..", "..");
const WEB_ROOT = resolve(ROOT, "web");
const WORK_ROOT = ROOT;

const jobs = new Map(); // jobId → {status, stage, note, logs[], result, workDir, videoPath, probe, shots}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  try {
    if (req.method === "OPTIONS") return ok(res, 204, null);

    // ---------------- JSON API ----------------
    if (path === "/api/rank" && req.method === "POST") {
      const body = await readJson(req);
      const source = String(body.source ?? "").trim();
      if (!source) return ok(res, 400, { error: "source required (local path or URL)" });
      // Caption translation mode; unknown values fall back to "none".
      const translate = TRANSLATE_MODES.includes(body.translate) ? body.translate : "none";
      const jobId = randomUUID();
      const job = { id: jobId, status: "queued", stage: "", note: "", logs: [], created: Date.now() };
      jobs.set(jobId, job);
      startRank(job, source, Number(body.top) || 6, { ...body, translate });
      return ok(res, 200, { jobId });
    }

    if (path === "/api/packs" && req.method === "GET") {
      return ok(res, 200, {
        packs: Object.keys(PACKS).map((id) => ({
          id,
          ...PACKS[id],
        })),
      });
    }

    if (path === "/api/preview/sample" && req.method === "GET") {
      const pack = url.searchParams.get("pack") ?? "highlight";
      if (!PACKS[pack]) return ok(res, 400, { error: `unknown pack ${pack}` });
      const positionPct = numOrNull(url.searchParams.get("position"));
      const scalePct = numOrNull(url.searchParams.get("scale")) ?? 1;
      const text = url.searchParams.get("text") ?? undefined;
      try {
        const file = await renderSamplePreview({
          pack,
          positionPct,
          scalePct,
          text: text ? String(text).slice(0, 90) : undefined,
        });
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        return res.end(rf(file));
      } catch (err) {
        return ok(res, 500, { error: err.message });
      }
    }

    if (path === "/api/upload" && req.method === "POST") {
      const name = url.searchParams.get("name") || "upload.mp4";
      const safe = name.replace(/[^a-z0-9._ -]+/gi, "_");
      const dir = resolve(WORK_ROOT, "uploads");
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${Date.now()}_${safe}`);
      const chunks = [];
      let size = 0;
      await new Promise((resolveUpload, rejectUpload) => {
        req.on("data", (c) => {
          size += c.length;
          if (size > 4 * 1024 * 1024 * 1024) {
            rejectUpload(new Error("upload too large"));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on("end", resolveUpload);
        req.on("error", rejectUpload);
      });
      writeFileSync(target, Buffer.concat(chunks));
      return ok(res, 200, { path: target });
    }

    const rankMatch = path.match(/^\/api\/rank\/([\w-]+)$/);
    if (rankMatch && req.method === "GET") {
      const job = jobs.get(rankMatch[1]);
      if (!job) return ok(res, 404, { error: "unknown job" });
      if (job.result) return ok(res, 200, job.result);
      return ok(res, 200, {
        status: job.status,
        stage: job.stage,
        finished: false,
        error: job.error ?? null,
      });
    }

    if (path === "/api/jobs" && req.method === "GET") {
      return ok(res, 200, [...jobs.values()].map(j => ({
        id: j.id, status: j.status, stage: j.stage, note: j.note, created: j.created,
        clipCount: j.result?.clips?.length ?? null,
      })));
    }

    const progressMatch = path.match(/^\/api\/progress\/([\w-]+)$/);
    if (progressMatch && req.method === "GET") {
      const job = jobs.get(progressMatch[1]);
      if (!job) return ok(res, 404, { error: "unknown job" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ stage: job.stage, note: job.note, status: job.status })}\n\n`);
      const listener = (snapshot) => res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      job.listeners.add(listener);
      if (job.status === "done" || job.status === "error") {
        res.write(`data: ${JSON.stringify({ status: job.status, error: job.error })}\n\n`);
      }
      req.on("close", () => job.listeners.delete(listener));
      return;
    }

    const previewMatch = path.match(/^\/api\/preview\/([\w-]+)\/(\d+)$/);
    if (previewMatch && req.method === "GET") {
      const job = jobs.get(previewMatch[1]);
      const rank = Number(previewMatch[2]);
      if (!job?.result) return ok(res, 404, { error: "unknown job or ranking not finished" });
      const clip = job.result.clips.find((c) => c.rank === rank);
      if (!clip) return ok(res, 404, { error: "unknown clip" });
      const pack = url.searchParams.get("pack") ?? job.result.renderSettings?.pack ?? "highlight";
      const positionPct = numOrNull(url.searchParams.get("position"));
      const scalePct = numOrNull(url.searchParams.get("scale")) ?? 1;
      const ratio = url.searchParams.get("ratio") ?? job.result.renderSettings?.ratio ?? "9:16";
      const words = windowWords(job.workDir, clip);
      const file = await renderStylePreview({
        probe: { ...job.probe, previewWidth: 405, previewHeight: 720 },
        clip: { ...clip, words, language: job.result.language },
        workDir: job.workDir,
        pack,
        positionPct,
        scalePct,
        ratio,
      });
      const type = "image/jpeg";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      return res.end(rf(file));
    }

    if (path === "/api/render" && req.method === "POST") {
      const body = await readJson(req);
      const job = jobs.get(String(body.jobId ?? ""));
      if (!job?.result) return ok(res, 400, { error: "unknown job or ranking not finished" });
      const indexes = (body.indexes ?? [1]).map(Number);
      const pack = String(body.pack ?? "highlight");
      // Client ratio is accepted but ignored — renders are always 9:16.
      const positionPct = numOrNull(body.positionPct);
      const scalePct = numOrNull(body.scalePct) ?? 1;
      const picks = job.result.clips.filter((c) => indexes.includes(c.rank));
      const outputs = [];
      for (const clip of picks) {
        const full = {
          ...clip,
          words: windowWords(job.workDir, clip),
          language: job.result.language,
        };
        const { file, plan, checks } = await renderClip({
          probe: job.probe,
          clip: full,
          workDir: job.workDir,
          opts: { pack, captions: captionsEnabled(body), positionPct, scalePct, shots: job.shots },
        });
        const base = file.split(/[\\/]/).pop();
        outputs.push({
          rank: clip.rank,
          file,
          url: `/media/${job.result.workId}/${base}`,
          score: clip.score,
          mode: plan.mode,
          checks: checks ?? null,
        });
      }
      return ok(res, 200, { outputs });
    }

    // ---------------- media ----------------
    const mediaMatch = path.match(/^\/media\/([\w-]+)\/(.+)$/);
    if (mediaMatch) {
      const dir = resolve(WORK_ROOT, ".work", mediaMatch[1]);
      const file = normalize(join(dir, mediaMatch[2]));
      if (!file.startsWith(dir) || !existsSync(file)) return ok(res, 404, { error: "not found" });
      const type = file.endsWith(".mp4") ? "video/mp4"
        : file.endsWith(".jpg") ? "image/jpeg"
        : file.endsWith(".json") ? "application/json" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Content-Length": statSync(file).size });
      return res.end(readFileSync(file));
    }

    // ---------------- static UI ----------------
    if (req.method === "GET") {
      const file = path === "/" ? "/index.html" : path;
      const target = normalize(join(WEB_ROOT, file));
      if (target.startsWith(WEB_ROOT) && existsSync(target) && statSync(target).isFile()) {
        const type = target.endsWith(".html") ? "text/html; charset=utf-8"
          : target.endsWith(".js") ? "text/javascript; charset=utf-8"
          : target.endsWith(".css") ? "text/css; charset=utf-8"
          : target.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        return res.end(readFileSync(target));
      }
      return ok(res, 404, { error: "not found" });
    }
    return ok(res, 405, { error: "method not allowed" });
  } catch (err) {
    return ok(res, 500, { error: err.message });
  }
});

function captionsEnabled(body) {
  return body.captions !== false;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function startRank(job, source, top, body = {}) {
  job.listeners = new Set();
  job.status = "running";
  const snapshot = () => ({ status: job.status, stage: job.stage, note: job.note });
  const emit = () => {
    for (const l of job.listeners) {
      try { l(snapshot()); } catch {}
    }
  };
  runRank({
    source,
    workRoot: WORK_ROOT,
    top,
    render: {
      pack: String(body.pack ?? "highlight"),
      positionPct: numOrNull(body.positionPct),
      scalePct: numOrNull(body.scalePct) ?? 1,
    },
    translate: body.translate ?? "none",
    autoRender: body.autoRender !== false,
    onStage: (stage, note) => {
      job.stage = stage;
      job.note = note ?? "";
      emit();
    },
    log: (line) => job.logs.push(line),
  })
    .then(({ result, workDir, videoPath, probe, shots }) => {
      job.result = result;
      job.workDir = workDir;
      job.videoPath = videoPath;
      job.probe = probe;
      job.shots = shots;
      job.status = "done";
      job.note = `${result.clips.length} clips`;
      emit();
    })
    .catch((err) => {
      job.status = "error";
      job.error = err.message;
      emit();
    });
}

function windowWords(workDir, clip) {
  const tPath = resolve(workDir, "transcribe.json");
  if (!existsSync(tPath)) return [];
  const doc = JSON.parse(rf(tPath, "utf8"));
  const offset = clip.finalStart ?? clip.start;
  const end = clip.finalEnd ?? clip.end;
  const words = [];
  for (const seg of doc.transcription ?? []) {
    for (const tok of seg.tokens ?? []) {
      const word = (tok.text ?? "").trim();
      if (!word || word.startsWith("[") || /^[_\-.,]+$/.test(word)) continue;
      const s = (tok.offsets?.from ?? 0) / 1000;
      const e = (tok.offsets?.to ?? 0) / 1000;
      // Final window ±0.25s; trimmed-out words are dropped, never clamped to 0.
      if (s >= offset - 0.25 && e <= end + 0.25) {
        const relEnd = e - offset;
        const relStart = s - offset;
        if (relEnd <= relStart || relEnd <= 0.01) continue;
        words.push({ start: Math.max(0, relStart), end: relEnd, word });
      }
    }
  }
  return words;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  await new Promise((res, rej) => {
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        rej(new Error("JSON body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", res);
    req.on("error", rej);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function ok(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload === null ? "" : JSON.stringify(payload));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[shotforge] web UI  →  http://localhost:${PORT}`);
  console.log(`[shotforge] work root  →  ${WORK_ROOT}`);
});
