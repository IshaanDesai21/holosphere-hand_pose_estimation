/**
 * hud.js
 * ─────────────────────────────────────────────────────────────
 * Manages all on-screen HUD element updates.
 * Keeps DOM writes batched to avoid layout thrashing.
 *
 * All DOM element references are resolved once at import time
 * (this module is only imported after the DOM is ready via
 * the deferred <script type="module"> in index.html).
 */

// ── Cache DOM references (resolved once) ─────────────────────
const elHandStatus  = document.getElementById('hand-status');
const elGestureType = document.getElementById('gesture-type');
const elHandCount   = document.getElementById('hand-count');
const elRotX        = document.getElementById('rot-x');
const elRotY        = document.getElementById('rot-y');
const elRotZ        = document.getElementById('rot-z');
const elZoomVal     = document.getElementById('zoom-val');
const elFps         = document.getElementById('fps-counter');

// ── Gesture → human-readable label map (module scope, not per-frame) ─
const GESTURE_LABELS = {
  NONE:     '—',
  FIST:     'Fist — paused',
  OPEN:     'Open — rotating',
  PINCH:    'Pinch — zoom',
  TWO_HAND: 'Two hands — scale / pan',
};

// ── FPS tracking ─────────────────────────────────────────────
let fpsFrames = 0;
let fpsLast   = performance.now();
let fpsSmooth = 60;

/** radians → degrees */
const R2D = 180 / Math.PI;

/**
 * updateHUD(gestureState, transforms)
 * Called once per RAF frame to refresh all HUD readouts.
 *
 * @param {import('./gesture.js').GestureState} g
 * @param {{ rotX: number, rotY: number, rotZ: number, scale: number } | null} t
 */
export function updateHUD(g, t) {
  // ── Hand detection status badge ───────────────────────────
  if (g.handCount > 0) {
    elHandStatus.textContent = g.handCount === 2 ? '2 Detected' : 'Detected';
    elHandStatus.className   = 'hud-value hud-badge hud-badge-active';
  } else {
    elHandStatus.textContent = 'No Hand';
    elHandStatus.className   = 'hud-value hud-badge hud-badge-inactive';
  }

  // ── Gesture label ─────────────────────────────────────────
  elGestureType.textContent = GESTURE_LABELS[g.gesture] ?? g.gesture;
  elHandCount.textContent   = String(g.handCount);

  // ── Transform readouts ────────────────────────────────────
  if (t) {
    elRotX.textContent    = `${(t.rotX * R2D).toFixed(1)}°`;
    elRotY.textContent    = `${(t.rotY * R2D).toFixed(1)}°`;
    elRotZ.textContent    = `${(t.rotZ * R2D).toFixed(1)}°`;
    elZoomVal.textContent = `${t.scale.toFixed(2)}×`;
  }
}

/**
 * tickFPS()
 * Called once per requestAnimationFrame.
 * Smooths FPS over 500ms windows and colour-codes the readout.
 *   ≥50 FPS → cyan
 *   30–49   → amber
 *   <30     → red
 */
export function tickFPS() {
  fpsFrames++;
  const now = performance.now();
  const dt  = now - fpsLast;

  if (dt >= 500) {
    const raw = (fpsFrames / dt) * 1000;
    fpsSmooth = fpsSmooth * 0.7 + raw * 0.3; // EMA blend
    fpsLast   = now;
    fpsFrames = 0;

    elFps.textContent = Math.round(fpsSmooth);
    elFps.style.color =
      fpsSmooth < 30 ? '#ef4444' :
      fpsSmooth < 50 ? '#eab308' :
                       '#00e5ff';
  }
}
