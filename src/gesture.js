/**
 * gesture.js
 * ─────────────────────────────────────────────────────────────
 * Anchor-based gesture classification.
 *
 * KEY DESIGN: outputs are DISPLACEMENTS FROM AN ANCHOR, not
 * per-frame deltas. This eliminates EMA lag / snap-back entirely.
 *
 *   When gesture starts  → record anchor position
 *   Each frame           → output (current - anchor) displacement
 *   When gesture ends    → sceneManager commits cur position as new base
 *   Next gesture starts  → anchor resets, displacement = 0 again
 *
 * Stability: gestures need STABILITY_FRAMES consecutive frames to
 * confirm. FIST and NONE are always immediate — stopping is always safe.
 */

import { LM } from './handTracker.js';

// ── Stability ──────────────────────────────────────────────
const STABILITY_FRAMES = 4;   // frames before a gesture is confirmed
const FIST_FROM_PINCH  = 4;   // frames of FIST needed to break an active PINCH

// ── Pinch thresholds (normalised by hand size) ────────────────
// Generous values: small hand tremors during a pinch will NOT
// trigger an accidental FIST and kill the gesture.
const PINCH_ENTER = 0.13;  // gap / handSize to enter pinch
const PINCH_EXIT  = 0.20;  // gap / handSize to release pinch (hysteresis)

// ── Finger extension ──────────────────────────────────────────
const EXTEND_THRESHOLD = 0.35;

// ── Dead-zone: displacements smaller than this are zeroed ─────
// Suppresses micro-tremor jitter without adding any latency
const DEAD_ZONE = 0.010;

// ── Stability state ───────────────────────────────────────────
let candidateGesture = 'NONE';
let candidateFrames  = 0;
let stableGesture    = 'NONE';

// ── Anchors set when each gesture first confirms ──────────────
let anchorPalm       = null; // {x,y} open-hand rotation anchor
let anchorPinchDist  = null; // distance when pinch started
let anchorTwoDist    = null; // palm-to-palm dist when two-hand started
let anchorTwoMid     = null; // midpoint when two-hand started
let anchorTwoAngle   = null; // angle when two-hand started

let isPinching = false; // pinch hysteresis state

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function dist2D(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid2D(a, b)  { return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 }; }
function angle2D(a, b){ return Math.atan2(b.y - a.y, b.x - a.x); }

/** Average of wrist + 4 MCP knuckles = palm centre */
function palmCenter(lm) {
  const pts = [
    lm[LM.WRIST],
    lm[LM.INDEX_MCP], lm[LM.MIDDLE_MCP],
    lm[LM.RING_MCP],  lm[LM.PINKY_MCP],
  ];
  const s = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: s.x / pts.length, y: s.y / pts.length };
}

/** Is the fingertip clearly above the PIP joint? (image-space, y↓) */
function isFingerExtended(lm, tipIdx, pipIdx) {
  return (lm[pipIdx].y - lm[tipIdx].y) >
    EXTEND_THRESHOLD * dist2D(lm[LM.WRIST], lm[LM.MIDDLE_MCP]);
}

function extendedFingerCount(lm) {
  let n = 0;
  if (isFingerExtended(lm, LM.INDEX_TIP,  LM.INDEX_PIP))  n++;
  if (isFingerExtended(lm, LM.MIDDLE_TIP, LM.MIDDLE_PIP)) n++;
  if (isFingerExtended(lm, LM.RING_TIP,   LM.RING_PIP))   n++;
  if (isFingerExtended(lm, LM.PINKY_TIP,  LM.PINKY_PIP))  n++;
  return n;
}

/** Raw (unstabilised) one-hand classification */
function classifyRaw(lm) {
  const pinchD   = dist2D(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]);
  const handSize = dist2D(lm[LM.WRIST], lm[LM.MIDDLE_MCP]);
  const norm     = pinchD / handSize;

  isPinching = isPinching ? norm < PINCH_EXIT : norm < PINCH_ENTER;
  if (isPinching) return 'PINCH';

  return extendedFingerCount(lm) <= 1 ? 'FIST' : 'OPEN';
}

// ─────────────────────────────────────────────────────────────
// Stability gate
// ─────────────────────────────────────────────────────────────

/**
 * confirmGesture(raw)
 *
 * Stability rules:
 *  - NONE  → always immediate (no hands = nothing to do)
 *  - FIST  → immediate when coming from OPEN/NONE
 *            BUT requires FIST_FROM_PINCH frames when breaking a PINCH,
 *            because fingers naturally curl during a pinch and brief
 *            FIST frames must not interrupt the zoom gesture.
 *  - other → STABILITY_FRAMES consecutive frames needed
 */
function confirmGesture(raw) {
  // No hands: immediate
  if (raw === 'NONE') {
    if (raw !== stableGesture) {
      anchorPalm      = null;
      anchorPinchDist = null;
    }
    stableGesture = raw;
    candidateGesture = raw;
    candidateFrames  = STABILITY_FRAMES;
    return stableGesture;
  }

  if (raw === 'FIST') {
    if (stableGesture === 'PINCH' || candidateGesture === 'PINCH') {
      // Don’t break a pinch instantly — fingers curl naturally while pinching.
      // Require FIST_FROM_PINCH consecutive FIST frames to confirm the break.
      if (raw === candidateGesture) {
        candidateFrames++;
        if (candidateFrames >= FIST_FROM_PINCH) {
          anchorPinchDist = null;
          stableGesture   = 'FIST';
        }
      } else {
        candidateGesture = raw;
        candidateFrames  = 1;
      }
    } else {
      // Coming from OPEN or NONE: lock immediately
      if (raw !== stableGesture) {
        anchorPalm      = null;
        anchorPinchDist = null;
      }
      stableGesture    = raw;
      candidateGesture = raw;
      candidateFrames  = STABILITY_FRAMES;
    }
    return stableGesture;
  }

  // All other gestures: standard stability window
  if (raw === candidateGesture) {
    candidateFrames++;
    if (candidateFrames >= STABILITY_FRAMES) {
      stableGesture = raw;
    }
  } else {
    // New candidate — keep showing previous stable gesture until it holds
    candidateGesture = raw;
    candidateFrames  = 1;
  }

  return stableGesture;
}

// ─────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GestureState
 * @property {'NONE'|'FIST'|'OPEN'|'PINCH'|'TWO_HAND'} gesture  – stable confirmed gesture
 * @property {number} rotDX       – rotation-X displacement from anchor (radians)
 * @property {number} rotDY       – rotation-Y displacement from anchor (radians)
 * @property {number} rotDZ       – rotation-Z displacement from anchor (radians)
 * @property {number} scaleFactor – scale ratio relative to anchor  (1.0 = no change)
 * @property {number} panDX       – pan-X displacement from anchor (normalised)
 * @property {number} panDY       – pan-Y displacement from anchor (normalised)
 * @property {number} handCount
 */

/**
 * processGestures(result)
 * Main entry. Accepts HandLandmarkerResult, returns GestureState.
 * All transform fields are relative to anchors — they do NOT accumulate
 * frame-by-frame, so they never drift or snap back.
 *
 * @param {HandLandmarkerResult|null} result
 * @returns {GestureState}
 */
export function processGestures(result) {
  const handCount = result?.landmarks?.length ?? 0;

  // Default: no displacement (scene manager will hold committed position)
  const out = {
    gesture: 'NONE',
    handCount,
    rotDX: 0, rotDY: 0, rotDZ: 0,
    scaleFactor: 1,
    panDX: 0, panDY: 0,
  };

  // ── No hands ──────────────────────────────────────────────
  if (handCount === 0) {
    confirmGesture('NONE');
    isPinching       = false;
    anchorPalm       = null;
    anchorPinchDist  = null;
    anchorTwoDist    = null;
    anchorTwoMid     = null;
    anchorTwoAngle   = null;
    return out;
  }

  // ── One hand ──────────────────────────────────────────────
  if (handCount === 1) {
    const lm      = result.landmarks[0];
    const raw     = classifyRaw(lm);
    const gesture = confirmGesture(raw);
    out.gesture   = gesture;

    // Always clear two-hand anchors when only one hand is visible
    anchorTwoDist  = null;
    anchorTwoMid   = null;
    anchorTwoAngle = null;

    if (gesture === 'OPEN') {
      const palm = palmCenter(lm);
      // Set anchor on first OPEN frame
      if (!anchorPalm) anchorPalm = palm;
      anchorPinchDist = null;

      // Displacement from anchor (dead-zone applied)
      let dx = palm.x - anchorPalm.x;
      let dy = palm.y - anchorPalm.y;
      if (Math.abs(dx) < DEAD_ZONE) dx = 0;
      if (Math.abs(dy) < DEAD_ZONE) dy = 0;

      // Image x increases right; webcam is mirrored, so -dx → rotate right
      // Image y increases down; move hand down → rotate downward (+X)
      out.rotDY = -dx;
      out.rotDX =  dy;

    } else if (gesture === 'PINCH') {
      const d = dist2D(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]);
      if (!anchorPinchDist) anchorPinchDist = d;
      anchorPalm = null;

      // Ratio relative to anchor: <1 = zooming in, >1 = zooming out
      out.scaleFactor = d / anchorPinchDist;

    } else {
      // FIST: clear anchors, output zeros → scene stays frozen at committed base
      anchorPalm      = null;
      anchorPinchDist = null;
    }
  }

  // ── Two hands ─────────────────────────────────────────────
  else {
    // Clear one-hand state
    anchorPalm      = null;
    anchorPinchDist = null;
    isPinching      = false;

    // Classify both hands
    const raw0 = classifyRaw(result.landmarks[0]);
    const raw1 = classifyRaw(result.landmarks[1]);

    // If AT LEAST ONE hand is a closed fist, act as idle/paused
    if (raw0 === 'FIST' || raw1 === 'FIST') {
      out.gesture = confirmGesture('FIST');
      anchorTwoDist  = null;
      anchorTwoMid   = null;
      anchorTwoAngle = null;
      return out;
    }

    const p0  = palmCenter(result.landmarks[0]);
    const p1  = palmCenter(result.landmarks[1]);
    const d   = dist2D(p0, p1);
    const mid = mid2D(p0, p1);
    const ang = angle2D(p0, p1);

    confirmGesture('TWO_HAND');
    out.gesture = stableGesture;

    if (stableGesture === 'TWO_HAND') {
      // Set anchors on first confirmed two-hand frame
      if (!anchorTwoDist) {
        anchorTwoDist  = d;
        anchorTwoMid   = mid;
        anchorTwoAngle = ang;
      }

      // Scale: ratio relative to starting distance (absolute, no drift)
      out.scaleFactor = d / anchorTwoDist;

      // Pan: displacement of midpoint from where two-hand started
      let panDX = mid.x - anchorTwoMid.x;
      let panDY = mid.y - anchorTwoMid.y;
      if (Math.abs(panDX) < DEAD_ZONE) panDX = 0;
      if (Math.abs(panDY) < DEAD_ZONE) panDY = 0;
      out.panDX = panDX;
      out.panDY = panDY;

      // Twist: angular displacement from anchor angle
      let dAng = ang - anchorTwoAngle;
      if (dAng >  Math.PI) dAng -= 2 * Math.PI;
      if (dAng < -Math.PI) dAng += 2 * Math.PI;
      out.rotDZ = dAng;
    }
  }

  return out;
}
