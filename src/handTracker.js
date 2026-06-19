/**
 * handTracker.js
 * ─────────────────────────────────────────────────────────────
 * Wraps the MediaPipe Tasks-Vision HandLandmarker.
 * Responsible for:
 *  - Loading the WASM runtime from CDN
 *  - Creating and configuring the HandLandmarker
 *  - Running async detection on video frames
 *  - Providing raw landmark data to gesture.js and renderer.js
 */

import {
  HandLandmarker,
  FilesetResolver
} from '@mediapipe/tasks-vision';

// ── MediaPipe CDN base (WASM files are served from here) ─────
const MEDIAPIPE_CDN =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

// ── Hand landmark indices (for reference in gesture logic) ────
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

/**
 * Skeleton connections drawn between landmark pairs.
 * Each entry is [from, to] using LM index numbers.
 */
export const CONNECTIONS = [
  // Thumb
  [0,1],[1,2],[2,3],[3,4],
  // Index
  [0,5],[5,6],[6,7],[7,8],
  // Middle
  [0,9],[9,10],[10,11],[11,12],
  // Ring
  [0,13],[13,14],[14,15],[15,16],
  // Pinky
  [0,17],[17,18],[18,19],[19,20],
  // Palm transversals
  [5,9],[9,13],[13,17],
];

/** Palm mesh triangles (CCW winding) */
export const PALM_TRIANGLES = [
  [0,5,9], [0,9,13], [0,13,17],
  [5,6,9], [9,10,13], [13,14,17],
];

let handLandmarker = null;
let lastVideoTime = -1;

/**
 * initialiseHandTracker()
 * Loads MediaPipe WASM assets and builds the HandLandmarker.
 * Must be called once before calling detectHands().
 */
export async function initialiseHandTracker() {
  // Resolve the WASM file set from CDN
  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_CDN);

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      // Use the full (accurate) model
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
      delegate: 'GPU', // Prefer GPU inference; falls back to CPU
    },
    runningMode: 'VIDEO',       // Optimised for live video streams
    numHands: 2,                // Detect up to 2 hands simultaneously
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });

  return handLandmarker;
}

/**
 * detectHands(videoElement)
 * Runs the hand landmarker on the current video frame.
 * Returns the raw HandLandmarkerResult object (or null if not ready).
 *
 * @param {HTMLVideoElement} videoEl
 * @returns {HandLandmarkerResult | null}
 */
export function detectHands(videoEl) {
  if (!handLandmarker) return null;
  if (videoEl.readyState < 2) return null; // HAVE_CURRENT_DATA

  const now = performance.now();
  // Avoid duplicate processing of the same frame
  if (videoEl.currentTime === lastVideoTime) return null;
  lastVideoTime = videoEl.currentTime;

  // detectForVideo is synchronous for VIDEO mode
  return handLandmarker.detectForVideo(videoEl, now);
}
