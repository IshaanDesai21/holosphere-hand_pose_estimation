/**
 * main.js
 * ─────────────────────────────────────────────────────────────
 * HoloSphere – Entry point
 *
 * Architecture overview:
 *  ┌─────────────────────────────────────────┐
 *  │  Webcam (video#webcam)                  │  z-index: 0
 *  │  Hand skeleton (canvas#hand-canvas)     │  z-index: 1
 *  │  Three.js scene (canvas#three-canvas)   │  z-index: 2
 *  │  HUD elements (HTML overlays)           │  z-index: 10
 *  └─────────────────────────────────────────┘
 *
 * Flow per requestAnimationFrame:
 *  1. detectHands()           → MediaPipe result
 *  2. renderHands()           → draw skeleton on 2D canvas
 *  3. processGestures()       → classify gesture from landmarks
 *  4. applyGestureTransform() → update Three.js model transforms
 *  5. autoRotate()            → rotate globe when idle
 *  6. renderScene()           → Three.js render call
 *  7. updateHUD()             → update DOM stats
 *  8. tickFPS()               → update FPS counter
 */

import './styles.css';

import { initialiseHandTracker, detectHands } from './handTracker.js';
import { renderHands, clearHandCanvas }       from './handRenderer.js';
import { processGestures }                    from './gesture.js';
import {
  initScene,
  renderScene,
  applyGestureTransform,
  autoRotate,
  loadSTL,
  loadGLTF,
} from './sceneManager.js';
import { updateHUD, tickFPS } from './hud.js';

// ── DOM references ───────────────────────────────────────────
const videoEl       = document.getElementById('webcam');
const handCanvas    = document.getElementById('hand-canvas');
const threeCanvas   = document.getElementById('three-canvas');
const overlay       = document.getElementById('overlay');
const startBtn      = document.getElementById('start-btn');
const loadingMsg    = document.getElementById('loading-msg');
const errorMsg      = document.getElementById('error-msg');
const modelUpload   = document.getElementById('model-upload');
const uploadStatus  = document.getElementById('upload-status');

// ── Canvas 2D context for hand skeleton ─────────────────────
const handCtx = handCanvas.getContext('2d');

// ── Application state ────────────────────────────────────────
let isRunning = false;
let lastResult = null;

// ── Resize hand canvas to match viewport ────────────────────
function resizeHandCanvas() {
  handCanvas.width  = window.innerWidth;
  handCanvas.height = window.innerHeight;
}
resizeHandCanvas();
window.addEventListener('resize', resizeHandCanvas);

// ═══════════════════════════════════════════════════════════
// STARTUP SEQUENCE
// ═══════════════════════════════════════════════════════════

startBtn.addEventListener('click', async () => {
  startBtn.classList.add('hidden');
  loadingMsg.classList.remove('hidden');
  errorMsg.classList.add('hidden');

  try {
    // Step 1: Request webcam access
    await startWebcam();

    // Step 2: Initialise Three.js scene
    initScene(threeCanvas);

    // Step 3: Load MediaPipe HandLandmarker (downloads WASM from CDN)
    await initialiseHandTracker();

    // Step 4: Hide overlay and start the render loop
    overlay.classList.add('hidden');
    isRunning = true;
    requestAnimationFrame(loop);

  } catch (err) {
    console.error('Startup error:', err);
    loadingMsg.classList.add('hidden');
    startBtn.classList.remove('hidden');
    errorMsg.classList.remove('hidden');
    errorMsg.textContent = `Error: ${err.message ?? err}. Please ensure camera permissions are granted and try again.`;
  }
});

/**
 * startWebcam()
 * Requests camera access and pipes the stream into the video element.
 * Uses ideal resolution + environment-facing camera on mobile.
 */
async function startWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
      frameRate: { ideal: 30 },
    },
    audio: false,
  });

  videoEl.srcObject = stream;
  return new Promise((resolve, reject) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play().then(resolve).catch(reject);
    };
    videoEl.onerror = reject;
  });
}

// ═══════════════════════════════════════════════════════════
// MAIN RENDER LOOP
// ═══════════════════════════════════════════════════════════

/**
 * loop()
 * Called every animation frame via requestAnimationFrame.
 * Coordinates all subsystems in the correct order.
 */
function loop() {
  if (!isRunning) return;
  requestAnimationFrame(loop);

  // 1. MediaPipe hand detection (synchronous on video frame)
  //    detectHands() returns null if the frame hasn't advanced — keep last result.
  const result = detectHands(videoEl);
  if (result !== null) {
    lastResult = result;
  }

  // 2. Draw hand skeleton on the 2D overlay canvas
  clearHandCanvas(handCtx, handCanvas);
  if (lastResult && lastResult.landmarks.length > 0) {
    renderHands(handCtx, handCanvas, lastResult.landmarks);
  }

  // 3. Classify gestures from landmark data
  //    Pass null when we have no result yet — processGestures handles this gracefully.
  const gestureState = processGestures(lastResult);

  // 4. Auto-rotate the globe when no hands are present.
  //    Must run BEFORE applyGestureTransform so the target increment
  //    is consumed in the same frame (not one frame late).
  autoRotate(gestureState);

  // 5. Apply gesture transforms to the Three.js model (with EMA damping)
  const transforms = applyGestureTransform(gestureState);

  // 6. Render the Three.js scene
  renderScene();

  // 7. Update HUD display elements
  updateHUD(gestureState, transforms);

  // 8. Track and display FPS
  tickFPS();
}

// ═══════════════════════════════════════════════════════════
// FILE UPLOAD — STL / GLB / GLTF
// ═══════════════════════════════════════════════════════════

async function processFile(file) {
  if (!file) return;

  const ext  = file.name.split('.').pop().toLowerCase();
  const name = file.name.length > 22
    ? file.name.slice(0, 19) + '…'
    : file.name;

  setUploadStatus(`Loading ${name}…`, 'loading');

  try {
    if (ext === 'stl') {
      const buffer = await file.arrayBuffer();
      loadSTL(buffer, () => setUploadStatus(`✓ ${name}`, 'success'));
    } else if (ext === 'glb' || ext === 'gltf') {
      const url = URL.createObjectURL(file);
      loadGLTF(url, (err) => {
        URL.revokeObjectURL(url);
        if (err) setUploadStatus(`✗ Failed to load`, 'error');
        else     setUploadStatus(`✓ ${name}`, 'success');
      });
    } else {
      setUploadStatus('Unsupported format', 'error');
    }
  } catch (err) {
    console.error('Upload error:', err);
    setUploadStatus(`✗ Error: ${err.message}`, 'error');
  }
}

// ── Via Button ───────────────────────────────────────────────
modelUpload.addEventListener('change', (e) => {
  processFile(e.target.files?.[0]);
  e.target.value = ''; // Reset so same file can be re-selected
});

// ── Via Drag & Drop ──────────────────────────────────────────
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    processFile(e.dataTransfer.files[0]);
  }
});

/**
 * setUploadStatus(msg, type)
 * Updates the upload status text with colour feedback.
 *
 * @param {string} msg
 * @param {'loading'|'success'|'error'} type
 */
function setUploadStatus(msg, type) {
  uploadStatus.textContent = msg;
  uploadStatus.style.color = {
    loading: '#94a3b8',
    success: '#22c55e',
    error:   '#ef4444',
  }[type] ?? '#94a3b8';

  // Auto-clear success messages after 4s
  if (type === 'success') {
    setTimeout(() => {
      if (uploadStatus.textContent === msg) {
        uploadStatus.textContent = '';
      }
    }, 4000);
  }
}
