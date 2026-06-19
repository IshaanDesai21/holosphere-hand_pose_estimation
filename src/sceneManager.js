/**
 * sceneManager.js
 * ─────────────────────────────────────────────────────────────
 * Three.js scene — transparent overlay over the webcam.
 *
 * Transform model:
 *   base*    — committed resting position (updated on gesture change)
 *   target*  — base + current gesture displacement
 *   cur*     — EMA-smoothed toward target (what the model actually shows)
 *
 * Because gesture.js outputs displacements from anchors (not per-frame
 * deltas), the target is stable while hands are stationary — no drift,
 * no snap-back when hands drop.
 */

import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { STLLoader }       from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { TilesRenderer }   from '3d-tiles-renderer';

// ── Sensitivity ───────────────────────────────────────────────
const ROT_SENSITIVITY   = 3.5;  // radians per normalised unit
const PAN_SENSITIVITY   = 2.5;
const TWIST_SENSITIVITY = 2.5;
const ZOOM_MIN          = 0.05;
const ZOOM_MAX          = 1500000.0; // Massive zoom max to reach street level
const PAN_LIMIT         = 100000.0;  // Allow panning across the massive zoomed globe

// ── EMA smoothing (lower = more lag, higher = more snap) ──────
const ROT_ALPHA   = 0.10;
const SCALE_ALPHA = 0.09;
const PAN_ALPHA   = 0.10;

// ── Auto-rotate when idle ─────────────────────────────────────
const AUTO_ROT_SPEED = 0.0015;

// ── Committed (resting) transforms ───────────────────────────
// Updated when the active gesture changes — ensures that dropping
// hands or fisting leaves the model exactly where it was.
let baseRotX  = 0, baseRotY  = 0, baseRotZ  = 0;
let baseScale = 1;
let basePanX  = 0, basePanY  = 0;

// ── Target transforms (base + live gesture displacement) ──────
let targetRotX  = 0, targetRotY  = 0, targetRotZ  = 0;
let targetScale = 1;
let targetPanX  = 0, targetPanY  = 0;

// ── Current smoothed transforms ───────────────────────────────
let curRotX  = 0, curRotY  = 0, curRotZ  = 0;
let curScale = 1;
let curPanX  = 0, curPanY  = 0;

// ── Previous gesture for change detection ─────────────────────
let prevGesture = 'NONE';

// ── Three.js objects ──────────────────────────────────────────
let renderer, camera, scene, controls;
let modelGroup;   // parent of whatever model is active
let globeGroup;   // the default auto-rotating globe
let activeModel = null;
let googleTiles = null; // reference to 3d-tiles-renderer

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────

/**
 * initScene(canvas)
 * Call once after DOM ready. Creates renderer, scene, globe.
 */
export function initScene(canvas) {
  // ── Renderer ──────────────────────────────────────────────
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,         // transparent background
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.shadowMap.enabled   = true;
  renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace    = THREE.SRGBColorSpace;

  // ── Scene ─────────────────────────────────────────────────
  scene = new THREE.Scene();

  // ── IBL environment (gives STL/GLTF models realistic reflections) ──
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // ── Camera ────────────────────────────────────────────────
  camera = new THREE.PerspectiveCamera(
    50,
    canvas.clientWidth / canvas.clientHeight,
    0.01, 1000
  );
  camera.position.set(0, 0, 3);

  // ── Lighting ──────────────────────────────────────────────
  setupLights();

  // ── OrbitControls ───────────────────────────────────────────
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance   = 0.3;
  controls.maxDistance   = 20;

  // ── Model group ───────────────────────────────────────────
  modelGroup = new THREE.Group();
  scene.add(modelGroup);

  // ── Default globe ─────────────────────────────────────────
  globeGroup  = buildGlobe();
  activeModel = globeGroup;
  modelGroup.add(globeGroup);

  window.addEventListener('resize', onResize);
  onResize();

  return { renderer, scene, camera, controls };
}

// ─────────────────────────────────────────────────────────────
// Globe
// ─────────────────────────────────────────────────────────────

function buildGlobe() {
  const group = new THREE.Group();

  // Initialize the TilesRenderer with the Google Maps API Key
  const apiKey = 'AIzaSyBXBT5vA8Kr7mwYmoUdpt3ILP5shv-cSq0';
  googleTiles = new TilesRenderer(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`);
  googleTiles.setCamera(camera);
  googleTiles.setResolutionFromRenderer(camera, renderer);

  // Google 3D Tiles are strictly ECEF (Earth-Centered, Earth-Fixed)
  // The earth has a radius of roughly 6,378,137 meters.
  // We scale this massive coordinate system down to our 2-unit viewer.
  // Scale = 2 / 12,756,274
  const scale = 2 / 12756274;
  googleTiles.group.scale.setScalar(scale);

  // ECEF coordinates have the Z-axis going through the North Pole.
  // Three.js uses Y-Up. Rotate the tile group to align.
  googleTiles.group.rotation.x = -Math.PI / 2;

  // Add the 3D tiles group to our globe group
  group.add(googleTiles.group);

  return group;
}

// ─────────────────────────────────────────────────────────────
// Lighting
// ─────────────────────────────────────────────────────────────

function setupLights() {
  scene.add(new THREE.AmbientLight(0x334466, 0.9));

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 8, 5);
  key.castShadow = true;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x8ab4f8, 0.5);
  fill.position.set(-4, -2, -4);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0x6688cc, 0.3);
  rim.position.set(0, -4, -4);
  scene.add(rim);
}

// ─────────────────────────────────────────────────────────────
// Model loading
// ─────────────────────────────────────────────────────────────

/**
 * loadSTL(buffer, onDone)
 * Parses an STL ArrayBuffer and replaces the active model.
 */
export function loadSTL(buffer, onDone) {
  const geo = new STLLoader().parse(buffer);

  // Centre and normalise to fit in a ~2-unit bounding box
  geo.computeBoundingBox();
  const centre = new THREE.Vector3();
  geo.boundingBox.getCenter(centre);
  geo.translate(-centre.x, -centre.y, -centre.z);
  const size = new THREE.Vector3();
  geo.boundingBox.getSize(size);
  const s = 2 / Math.max(size.x, size.y, size.z);
  geo.scale(s, s, s);

  const mesh = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
    color:              0x8ab4f8,
    metalness:          0.55,
    roughness:          0.35,
    clearcoat:          0.4,
    clearcoatRoughness: 0.15,
  }));
  mesh.castShadow    = true;
  mesh.receiveShadow = true;

  replaceModel(mesh);
  onDone?.();
}

/**
 * loadGLTF(url, onDone)
 * Loads a GLB/GLTF from a Blob URL.
 */
export function loadGLTF(url, onDone) {
  new GLTFLoader().load(url, (gltf) => {
    const model = gltf.scene;

    // Fit to ~2-unit bounding box
    const box = new THREE.Box3().setFromObject(model);
    const c   = new THREE.Vector3();
    box.getCenter(c);
    model.position.sub(c);
    const sz = new THREE.Vector3();
    box.getSize(sz);
    model.scale.setScalar(2 / Math.max(sz.x, sz.y, sz.z));

    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow    = true;
        child.receiveShadow = true;
      }
    });

    replaceModel(model);
    onDone?.();
  }, undefined, (err) => {
    console.error('GLTF load error:', err);
    onDone?.(err);
  });
}

/** Dispose old model and swap in new one. Resets all transforms. */
function replaceModel(object) {
  while (modelGroup.children.length > 0) {
    const child = modelGroup.children[0];
    modelGroup.remove(child);
    child.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.isMesh) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach(m => m?.dispose());
      }
    });
  }

  // Reset base + current transforms
  baseRotX = 0; baseRotY = 0; baseRotZ = 0;
  baseScale = 1; basePanX = 0; basePanY = 0;
  targetRotX = 0; targetRotY = 0; targetRotZ = 0;
  targetScale = 1; targetPanX = 0; targetPanY = 0;
  curRotX = 0; curRotY = 0; curRotZ = 0;
  curScale = 1; curPanX = 0; curPanY = 0;
  prevGesture = 'NONE';

  modelGroup.position.set(0, 0, 0);
  modelGroup.rotation.set(0, 0, 0);
  modelGroup.scale.setScalar(1);

  modelGroup.add(object);
  activeModel = object;
}

// ─────────────────────────────────────────────────────────────
// Gesture transforms
// ─────────────────────────────────────────────────────────────

/**
 * applyGestureTransform(g)
 * Called every frame with the current GestureState.
 *
 * The scene manager owns the "base" (committed resting transforms).
 * When the gesture changes, we commit curRot/Scale/Pan → base,
 * so the model stays exactly where it is when you fist or drop hands.
 *
 * Target = base + gesture displacement.
 * Cur    = EMA toward target.
 */
export function applyGestureTransform(g) {
  const isActive = g.gesture !== 'NONE' && g.gesture !== 'FIST';

  // Disable mouse orbit when hand gesture is active
  if (controls) controls.enabled = !isActive;

  // ── Detect gesture change → commit current position ──────
  if (g.gesture !== prevGesture) {
    // Any time the gesture changes, lock in where the model currently sits.
    // This is what prevents snap-back: the next gesture starts from here.
    baseRotX  = curRotX;
    baseRotY  = curRotY;
    baseRotZ  = curRotZ;
    baseScale = curScale;
    basePanX  = curPanX;
    basePanY  = curPanY;

    prevGesture = g.gesture;
  }

  // ── Compute targets from base + anchor displacement ──────
  if (g.gesture === 'OPEN') {
    // Hand displacement from anchor → rotation change from base
    targetRotX = baseRotX + g.rotDX * ROT_SENSITIVITY;
    targetRotY = baseRotY + g.rotDY * ROT_SENSITIVITY;
    targetRotZ = baseRotZ;
    targetScale = baseScale;
    targetPanX  = basePanX;
    targetPanY  = basePanY;

  } else if (g.gesture === 'PINCH') {
    // Pinch distance ratio → scale relative to base
    targetScale = THREE.MathUtils.clamp(
      baseScale * g.scaleFactor, ZOOM_MIN, ZOOM_MAX
    );
    targetRotX = baseRotX;
    targetRotY = baseRotY;
    targetRotZ = baseRotZ;
    targetPanX = basePanX;
    targetPanY = basePanY;

  } else if (g.gesture === 'TWO_HAND') {
    // All three two-hand effects applied simultaneously
    targetScale = THREE.MathUtils.clamp(
      baseScale * g.scaleFactor, ZOOM_MIN, ZOOM_MAX
    );
    targetPanX = THREE.MathUtils.clamp(
      basePanX - g.panDX * PAN_SENSITIVITY, -PAN_LIMIT, PAN_LIMIT
    );
    targetPanY = THREE.MathUtils.clamp(
      basePanY + g.panDY * PAN_SENSITIVITY, -PAN_LIMIT, PAN_LIMIT
    );
    targetRotZ = baseRotZ + g.rotDZ * TWIST_SENSITIVITY;
    targetRotX = baseRotX;
    targetRotY = baseRotY;

  } else {
    // FIST or NONE: hold at committed base — the model freezes
    targetRotX  = baseRotX;
    targetRotY  = baseRotY;
    targetRotZ  = baseRotZ;
    targetScale = baseScale;
    targetPanX  = basePanX;
    targetPanY  = basePanY;
  }

  // ── EMA smooth toward target ──────────────────────────────
  curRotX  += (targetRotX  - curRotX)  * ROT_ALPHA;
  curRotY  += (targetRotY  - curRotY)  * ROT_ALPHA;
  curRotZ  += (targetRotZ  - curRotZ)  * ROT_ALPHA;
  curScale += (targetScale - curScale) * SCALE_ALPHA;
  curPanX  += (targetPanX  - curPanX)  * PAN_ALPHA;
  curPanY  += (targetPanY  - curPanY)  * PAN_ALPHA;

  // ── Apply to Three.js group ───────────────────────────────
  modelGroup.rotation.x  = curRotX;
  modelGroup.rotation.y  = curRotY;
  modelGroup.rotation.z  = curRotZ;
  modelGroup.scale.setScalar(curScale);
  modelGroup.position.x  =  curPanX;
  modelGroup.position.y  = -curPanY; // image y↓ vs Three y↑

  return { rotX: curRotX, rotY: curRotY, rotZ: curRotZ, scale: curScale };
}

/**
 * autoRotate(gestureState)
 * Gently rotate the globe when no hands visible.
 * Updates both baseRotY and targetRotY so EMA tracks cleanly.
 */
export function autoRotate(gestureState) {
  if (gestureState.handCount === 0 && activeModel === globeGroup) {
    baseRotY   += AUTO_ROT_SPEED;
    targetRotY  = baseRotY;
  }
}

// ─────────────────────────────────────────────────────────────
// Render / resize
// ─────────────────────────────────────────────────────────────

export function renderScene() {
  if (controls) controls.update();
  if (googleTiles) {
    googleTiles.setCamera(camera);
    googleTiles.setResolutionFromRenderer(camera, renderer);
    googleTiles.update();
  }
  renderer.render(scene, camera);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

export function getGlobeGroup() { return globeGroup; }
export function getModelGroup() { return modelGroup; }
