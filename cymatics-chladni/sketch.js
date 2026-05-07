/**
 * Radial, center-based pixel field: concentric rings + angular spokes,
 * weighted by audio bands. Chunky low-res buffer, fixed palette.
 */

let sound;
let blobUrl;
let fft;
let audioLoaded = false;
const FFT_BINS = 256;
/** Max square canvas side (px); larger window → more on-screen pixels. */
const MAX_CANVAS_SIDE = 560;

let plateSize;
let plateBuffer;

/** FFT slices → weights for radial harmonics. */
const RADIAL_LAYERS = 16;

/** Internal grid resolution along one axis (more = finer “pixels”, heavier CPU). */
const PIXEL_GRID_MIN = 32;
const PIXEL_GRID_MAX = 96;
/** Heavy pixel pass runs every Nth frame (1 = every frame). */
const PLATE_UPDATE_INTERVAL = 2;
const BASE_PALETTE = [
  [2, 3, 8],
  [14, 16, 34],
  [32, 38, 72],
  [68, 78, 128],
  [105, 115, 178],
  [158, 168, 222],
];
const BASE_WHEEL_HUE = 226;
const EDGE_SHARP = 2.35;
const EDGE_MAG_SCALE = 11;
const LUM_CONTRAST = 1.28;
const LUM_STRETCH = 1.38;
/** Neighbor blend amount for connected pixel islands (0 = none, 1 = very soft). */
const SPATIAL_COHESION = 0.62;

let smoothBands;
let activePalette = BASE_PALETTE.map((rgb) => rgb.slice());

function remakePlateBuffer() {
  const gSide = constrain(
    floor(plateSize / 8),
    PIXEL_GRID_MIN,
    PIXEL_GRID_MAX
  );
  plateBuffer = createGraphics(gSide, gSide);
  plateBuffer.pixelDensity(1);
}

function setup() {
  smoothBands = new Array(RADIAL_LAYERS).fill(0.15);
  const side = min(windowWidth - 40, min(windowHeight - 200, MAX_CANVAS_SIDE));
  plateSize = side;
  const cnv = createCanvas(side, side);
  cnv.parent("canvas-host");
  pixelDensity(1);
  noSmooth();
  remakePlateBuffer();

  fft = new p5.FFT(0.85, FFT_BINS);

  const fileInput = document.getElementById("audioFile");
  const rgbWheel = document.getElementById("rgbWheel");
  const statusEl = document.getElementById("status");
  if (rgbWheel) {
    applyPaletteHueFromHex(rgbWheel.value);
    rgbWheel.addEventListener("input", (e) => {
      applyPaletteHueFromHex(e.target.value);
    });
  }
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (sound) {
      sound.stop();
      sound.disconnect();
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
    blobUrl = URL.createObjectURL(f);
    sound = loadSound(
      blobUrl,
      () => {
        sound.setLoop(false);
        fft.setInput(sound);
        const ctx = getAudioContext();
        if (ctx && ctx.state !== "running") ctx.resume();
        sound.play();
        audioLoaded = true;
        statusEl.textContent =
          "Playing once: " + f.name + " — audio shapes the radial pattern.";
      },
      (err) => {
        statusEl.textContent = "Could not decode file. Try mp3/wav/ogg/m4a.";
        console.error(err);
      }
    );
  });
}

function windowResized() {
  const side = min(windowWidth - 40, min(windowHeight - 200, MAX_CANVAS_SIDE));
  if (abs(side - plateSize) > 10) {
    plateSize = side;
    resizeCanvas(side, side);
    remakePlateBuffer();
  }
}

function draw() {
  background(10, 10, 15);

  let spectrum = audioLoaded ? fft.analyze() : null;
  let raw = bandEnergies(spectrum);
  const smooth = audioLoaded ? 0.18 : 0.06;
  for (let i = 0; i < raw.length; i++) {
    smoothBands[i] = lerp(smoothBands[i], raw[i], smooth);
  }
  let bands = smoothBands;

  const gw = plateBuffer.width;
  const gh = plateBuffer.height;
  const t = millis() * 0.001;

  if ((frameCount - 1) % PLATE_UPDATE_INTERVAL === 0) {
    plateBuffer.loadPixels();
    const px = plateBuffer.pixels;
    const nPal = activePalette.length;
    const lumField = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const u = (2 * (x + 0.5)) / gw - 1;
        const v = (2 * (y + 0.5)) / gh - 1;

        let disp = radialField(u, v, bands, t);
        const mag = abs(disp);

        const emphasis = pow(1 / (1 + mag * EDGE_MAG_SCALE), EDGE_SHARP);
        const sparkle = audioLoaded
          ? bands[0] * 0.12
          : 0.06 * (0.5 + 0.5 * sin(t * 0.7));

        let lum = 0.02 + emphasis * 0.9 + sparkle * 0.05;
        const vign = 1 - 0.28 * (sq(u) + sq(v));
        lum *= vign;
        lum = constrain(lum, 0, 1);
        lum = constrain(pow(lum, LUM_CONTRAST), 0, 1);
        lum = constrain((lum - 0.5) * LUM_STRETCH + 0.5, 0, 1);
        lumField[y * gw + x] = lum;
      }
    }

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const centerLum = lumField[i];
        const l = lumField[y * gw + max(0, x - 1)];
        const r = lumField[y * gw + min(gw - 1, x + 1)];
        const u = lumField[max(0, y - 1) * gw + x];
        const d = lumField[min(gh - 1, y + 1) * gw + x];
        const avg = (centerLum + l + r + u + d) * 0.2;
        const lum = lerp(centerLum, avg, SPATIAL_COHESION);

        let pi = floor(lum * nPal);
        if (pi >= nPal) pi = nPal - 1;
        const c = activePalette[pi];

        const idx = 4 * i;
        px[idx] = c[0];
        px[idx + 1] = c[1];
        px[idx + 2] = c[2];
        px[idx + 3] = 255;
      }
    }
    plateBuffer.updatePixels();
  }

  const lay = plateLayout();
  image(plateBuffer, lay.ox, lay.oy, lay.drawW, lay.drawH);

  noFill();
  stroke(51, 56, 77, 130);
  strokeWeight(1);
  rect(lay.ox, lay.oy, lay.drawW - 1, lay.drawH - 1);
}

function plateLayout() {
  const gw = plateBuffer.width;
  const gh = plateBuffer.height;
  const s = max(1, floor(min(width, height) / max(gw, gh)));
  const drawW = gw * s;
  const drawH = gh * s;
  const ox = floor((width - drawW) * 0.5);
  const oy = floor((height - drawH) * 0.5);
  return { ox, oy, drawW, drawH };
}

function bandEnergies(spectrum) {
  const out = [];
  if (!spectrum || spectrum.length === 0) {
    for (let i = 0; i < RADIAL_LAYERS; i++) out.push(0.15);
    return out;
  }
  const n = spectrum.length;
  const block = floor(n / RADIAL_LAYERS);
  for (let i = 0; i < RADIAL_LAYERS; i++) {
    let sum = 0;
    const start = i * block;
    const end = min((i + 1) * block, n);
    for (let j = start; j < end; j++) sum += spectrum[j];
    out.push(sum / ((end - start) * 255));
  }
  return out;
}

/**
 * u,v in [-1,1], origin at center. Rings (radius) + spokes (angle), animated.
 */
function radialField(u, v, bands, t) {
  const rd = constrain(sqrt(sq(u) + sq(v)) * 1.12, 0, 0.997);
  const ang = atan2(v, u);

  let sum = 0;
  let wsum = 0;
  for (let k = 0; k < RADIAL_LAYERS; k++) {
    const w = max(bands[k] ?? 0.08, 0.04);
    const freq = (k + 1) * (6.5 + k * 0.15);
    const rings = sin(freq * rd - t * (1.1 + k * 0.09) + w * 2.5);
    sum += w * rings;
    wsum += w;
  }
  if (wsum > 1e-6) sum /= wsum;

  const b0 = bands[0] ?? 0.12;
  const b1 = bands[1] ?? 0.12;
  const spokes =
    0.42 *
    sin(5 * ang + t * 0.55 + b0 * 5) *
    sin(4 * ang - t * 0.35 + b1 * 4);

  let out = sum + spokes;

  if (!audioLoaded) {
    const idleRing = sin(rd * 16 - t * 1.8) * cos(6 * ang + t * 0.25);
    const idlePulse = sin(t * 0.4) * sin(rd * 22 - t * 2.2);
    out += 0.22 * idleRing + 0.12 * idlePulse;
  }

  return out;
}

function applyPaletteHueFromHex(hex) {
  const hsv = hexToHsv(hex);
  const hueShiftDeg = hsv.h - BASE_WHEEL_HUE;
  activePalette = BASE_PALETTE.map((rgb) => rotateHue(rgb, hueShiftDeg));
}

function rotateHue(rgb, hueShiftDeg) {
  const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const shiftedHue = (hsv.h + hueShiftDeg + 360) % 360;
  const out = hsvToRgb(shiftedHue, hsv.s, hsv.v);
  return [out[0], out[1], out[2]];
}

function hexToHsv(hex) {
  const clean = (hex || "#ffffff").replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) || 255;
  const g = parseInt(clean.slice(2, 4), 16) || 255;
  const b = parseInt(clean.slice(4, 6), 16) || 255;
  return rgbToHsv(r, g, b);
}

function rgbToHsv(r255, g255, b255) {
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const maxv = max(r, g, b);
  const minv = min(r, g, b);
  const d = maxv - minv;
  let h = 0;

  if (d > 1e-6) {
    if (maxv === r) h = ((g - b) / d) % 6;
    else if (maxv === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = maxv === 0 ? 0 : d / maxv;
  return { h, s, v: maxv };
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }

  const m = v - c;
  return [
    round((r1 + m) * 255),
    round((g1 + m) * 255),
    round((b1 + m) * 255),
  ];
}
