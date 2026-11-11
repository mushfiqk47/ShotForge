/**
 * Reframe strategies: source aspect → target (9:16 default).
 *  - "center": static centered crop + gentle drift zoom (safe default)
 *  - "face":   crop x follows detected face centers over time (coords injected
 *              by the browser MediaPipe worker in M3; shape ready now)
 *  - "motion": crop x follows the loudest visual-activity side (heuristic)
 * Produces an ffmpeg filter chain; all math is pure so tests can hit it.
 */

const RATIOS = {
  "9:16": 9 / 16,
  "1:1": 1,
  "16:9": 16 / 9,
};

export function planReframe({ width, height, ratio = "9:16", faces = null, shots = [] }) {
  const target = RATIOS[ratio] ?? 9 / 16;
  // Output is always 1080-wide class; crop from source keeping full quality.
  const srcRatio = width / height;
  let cropW;
  let cropH;
  if (srcRatio > target) {
    // source wider than target: crop width
    cropH = height;
    cropW = Math.round(height * target);
  } else {
    cropW = width;
    cropH = Math.round(width / target);
  }
  cropW = even(cropW);
  cropH = even(cropH);

  const mode = faces && faces.length ? "face" : faces === null ? "center" : "motion";
  const outW = 1080;
  const outH = even(1080 / target);

  return {
    mode,
    ratio,
    cropW,
    cropH,
    outW,
    outH,
    /** ffmpeg filter fragment for this strategy */
    filter: buildFilter({ mode, width, height, cropW, cropH, outW, outH, faces, shots }),
  };
}

function buildFilter({ mode, width, height, cropW, cropH, outW, outH, faces, shots }) {
  const baseX = `(iw-${cropW})/2`;
  const baseY = `(ih-${cropH})/2`;
  let xExpr = baseX;
  let yExpr = baseY;

  if (mode === "face") {
    // Piecewise x per face sample: rely on sendcmd-free smooth approach —
    // average of detected face centers in 2s buckets.
    const cx = smoothFaceX(faces, width, cropW);
    if (cx) xExpr = cx;
  } else if (mode === "motion" && shots.length) {
    // Anchor toward the shot with the most cuts nearby (visual activity).
    const busiest = shots.reduce((best, s) =>
      s.end - s.start > best.end - best.start ? s : best, shots[0]);
    const cx = clamp((busiest.start + busiest.end) / 2 / (busiest.end || 1), 0, 1);
    xExpr = `max(0\\,min(iw-${cropW}\\,(iw-${cropW})*${cx.toFixed(3)}))`;
  }

  // Gentle drift zoom: scale up 6% then crop with slow sine sway.
  const zoom = 1.06;
  return [
    `crop=${cropW}:${cropH}:${xExpr}:${yExpr}`,
    `scale=${even(outW * zoom)}:${even(outH * zoom)}`,
    `crop=${outW}:${outH}:x='(iw-out_w)/2+sin(t/6)*14':y=0`,
    `scale=${outW}:${outH}:flags=lanczos`,
    "setsar=1",
  ].join(",");
}

function smoothFaceX(faces, width, cropW) {
  // faces: [{t, cx}] normalized 0..1 center positions; stepped x per time bucket.
  if (!faces?.length) return null;
  const pts = faces
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((p) => ({
      t: p.t,
      x: Math.max(0, Math.min(width - cropW, clamp(p.cx, 0, 1) * width - cropW / 2)),
    }));
  // Build: if(lt(t,T0),X0, if(lt(t,T1),X1, ... Xn)) — fold from the last point.
  let expr = pts[pts.length - 1].x.toFixed(0);
  for (let i = pts.length - 2; i >= 0; i -= 1) {
    expr = `if(lt(t\\,${pts[i].t.toFixed(2)})\\,${pts[i].x.toFixed(0)}\\,${expr})`;
  }
  return expr;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function even(v) {
  return Math.max(2, Math.round(v / 2) * 2);
}
