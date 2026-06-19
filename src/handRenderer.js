/**
 * handRenderer.js
 * ─────────────────────────────────────────────────────────────
 * Draws the hand skeleton overlay on a 2D canvas.
 * Renders: palm mesh fill → bone lines → joint dots.
 *
 * The canvas is CSS-mirrored (scaleX(-1)) to match the webcam,
 * so we draw in un-mirrored normalised MediaPipe coordinates.
 */

import { CONNECTIONS, PALM_TRIANGLES } from './handTracker.js';

// ── Palette — subtle white-on-dark, no neon ──────────────────
const C = {
  palmFill:   'rgba(255, 255, 255, 0.04)',
  palmEdge:   'rgba(255, 255, 255, 0.12)',
  boneGlow:   'rgba(255, 255, 255, 0.06)',
  bone:       'rgba(255, 255, 255, 0.55)',
  joint:      'rgba(255, 255, 255, 0.80)',
  tip:        'rgba(160, 210, 255, 0.90)', // fingertip: softer blue-white
};

/**
 * clearHandCanvas(ctx, canvas)
 */
export function clearHandCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * renderHands(ctx, canvas, landmarks)
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {Array<Array<{x,y,z}>>} landmarks
 */
export function renderHands(ctx, canvas, landmarks) {
  if (!landmarks || landmarks.length === 0) return;

  const W = canvas.width;
  const H = canvas.height;

  for (const lm of landmarks) {
    const pts = lm.map(p => ({ x: p.x * W, y: p.y * H }));
    drawPalm(ctx, pts);
    drawBones(ctx, pts);
    drawJoints(ctx, pts);
  }
}

function drawPalm(ctx, pts) {
  ctx.save();
  ctx.fillStyle   = C.palmFill;
  ctx.strokeStyle = C.palmEdge;
  ctx.lineWidth   = 0.8;

  for (const [a, b, c] of PALM_TRIANGLES) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.lineTo(pts[c].x, pts[c].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawBones(ctx, pts) {
  ctx.save();
  ctx.lineCap = 'round';

  // Soft outer glow pass
  ctx.strokeStyle = C.boneGlow;
  ctx.lineWidth   = 6;
  for (const [a, b] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  }

  // Core bone line
  ctx.strokeStyle = C.bone;
  ctx.lineWidth   = 1.2;
  for (const [a, b] of CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  }

  ctx.restore();
}

const TIPS = new Set([4, 8, 12, 16, 20]);

function drawJoints(ctx, pts) {
  for (let i = 0; i < pts.length; i++) {
    const { x, y } = pts[i];
    const isTip    = TIPS.has(i);
    const r        = isTip ? 4.5 : 2.5;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isTip ? C.tip : C.joint;
    ctx.fill();
    ctx.restore();
  }
}
