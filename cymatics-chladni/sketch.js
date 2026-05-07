/**
 * Radial, center-based pixel field: concentric rings + angular spokes,
 * weighted by audio bands. Chunky low-res buffer, fixed palette.
 */

let sound;
let fft;
let audioLoaded = false;
const FFT_BINS = 256;
/** Optional filter: pass ?creator=tz1... to force one minter. */
const CREATOR_ADDRESS = new URLSearchParams(window.location.search).get("creator") || "";
const OBJKT_CONTRACT = "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton";
const OBJKT_PAGE_BASE = "https://objkt.com/tokens";
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
/** 0 = latest audio OBJKT, 1 = previous to latest, etc. */
const AUDIO_OBJKT_OFFSET = 0;

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
const BASE_PALETTE_HUE = 226;
const EDGE_SHARP = 2.35;
const EDGE_MAG_SCALE = 11;
const LUM_CONTRAST = 1.28;
const LUM_STRETCH = 1.38;
/** Neighbor blend amount for connected pixel islands (0 = none, 1 = very soft). */
const SPATIAL_COHESION = 0.62;

let smoothBands;
let activePalette = BASE_PALETTE.map((rgb) => rgb.slice());
let objktMetaEl;
let needsGestureToStart = false;
let currentObjktTokenId = "";
let currentObjktName = "";

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
  plateSize = max(windowWidth, windowHeight);
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent("canvas-host");
  pixelDensity(1);
  noSmooth();
  remakePlateBuffer();

  fft = new p5.FFT(0.85, FFT_BINS);

  objktMetaEl = document.getElementById("objktMetaValue");
  loadLatestMintedAudioObjkt();
}

function windowResized() {
  plateSize = max(windowWidth, windowHeight);
  resizeCanvas(windowWidth, windowHeight);
  remakePlateBuffer();
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

  image(plateBuffer, 0, 0, width, height);
}

function mousePressed() {
  if (needsGestureToStart) startSoundAfterGesture();
}

function keyPressed() {
  if (key === "f" || key === "F") {
    const fs = fullscreen();
    fullscreen(!fs);
  }
}

function touchStarted() {
  if (needsGestureToStart) startSoundAfterGesture();
  return false;
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

async function loadLatestMintedAudioObjkt() {
  if (!objktMetaEl) return;
  objktMetaEl.textContent = "Now Visualising: loading OBJKT...";
  try {
    const token = await fetchAudioTokenByOffset(CREATOR_ADDRESS, AUDIO_OBJKT_OFFSET);
    if (!token) {
      objktMetaEl.textContent = "Now Visualising: no audio OBJKT found.";
      return;
    }

    const artifact = readArtifactUri(token.metadata);
    if (!artifact) {
      objktMetaEl.textContent = "Now Visualising: OBJKT missing artifact URI.";
      return;
    }

    const audioUrl = toHttpUri(artifact);
    const objktUrl = tokenObjktUrl(token.tokenId);
    currentObjktTokenId = String(token.tokenId || "");
    currentObjktName = String((token.metadata && token.metadata.name) || "").trim();
    await applyPaletteFromObjktCover(token.metadata);
    if (objktMetaEl) {
      const label = currentObjktName
        ? currentObjktName + " (OBJKT #" + token.tokenId + ")"
        : "OBJKT #" + token.tokenId;
      objktMetaEl.innerHTML =
        'Now Visualising: ' +
        '<a href="' +
        objktUrl +
        '" target="_blank" rel="noopener noreferrer">' +
        label +
        "</a>";
    }
    loadSoundFromUrl(audioUrl, token.tokenId);
  } catch (err) {
    if (objktMetaEl) objktMetaEl.textContent = "Now Visualising: OBJKT fetch failed.";
    console.error(err);
  }
}

async function fetchAudioTokenByOffset(creatorAddress, audioOffset) {
  const pageSize = 200;
  const maxPages = 8;
  let seenAudio = 0;

  for (let page = 0; page < maxPages; page++) {
    let url =
      "https://api.tzkt.io/v1/tokens?" +
      "contract=" +
      encodeURIComponent(OBJKT_CONTRACT) +
      "&sort.desc=tokenId" +
      "&offset=" +
      String(page * pageSize) +
      "&limit=" +
      String(pageSize);

    if (creatorAddress) {
      url += "&creator=" + encodeURIComponent(creatorAddress);
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error("TzKT request failed: " + res.status);
    const tokens = await res.json();
    if (!Array.isArray(tokens) || tokens.length === 0) break;

    for (const t of tokens) {
      if (!isAudioMetadata(t.metadata)) continue;
      if (seenAudio === audioOffset) return t;
      seenAudio++;
    }
  }

  return null;
}

function isAudioMetadata(metadata) {
  if (!metadata) return false;
  const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
  for (const f of formats) {
    const mt = (f.mimeType || f.mime || "").toLowerCase();
    if (mt.startsWith("audio/")) return true;
  }
  const artifact = (metadata.artifactUri || metadata.artifact_uri || "").toLowerCase();
  return artifact.endsWith(".mp3") || artifact.endsWith(".wav") || artifact.endsWith(".ogg");
}

function readArtifactUri(metadata) {
  if (!metadata) return "";
  if (metadata.artifactUri) return metadata.artifactUri;
  if (metadata.artifact_uri) return metadata.artifact_uri;
  const formats = Array.isArray(metadata.formats) ? metadata.formats : [];
  for (const f of formats) {
    const mt = (f.mimeType || f.mime || "").toLowerCase();
    if (mt.startsWith("audio/") && f.uri) return f.uri;
  }
  return "";
}

function toHttpUri(uri) {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) return IPFS_GATEWAY + uri.slice("ipfs://".length);
  return uri;
}

function tokenObjktUrl(tokenId) {
  return OBJKT_PAGE_BASE + "/" + OBJKT_CONTRACT + "/" + tokenId;
}

function readCoverUri(metadata) {
  if (!metadata) return "";
  return metadata.displayUri || metadata.thumbnailUri || metadata.image || "";
}

async function applyPaletteFromObjktCover(metadata) {
  const cover = readCoverUri(metadata);
  if (!cover) return;
  const coverHttp = toHttpUri(cover);
  try {
    const dominant = await extractDominantRgb(coverHttp);
    const hsv = rgbToHsv(dominant[0], dominant[1], dominant[2]);
    const hueShiftDeg = hsv.h - BASE_PALETTE_HUE;
    activePalette = BASE_PALETTE.map((rgb) => rotateHue(rgb, hueShiftDeg));
  } catch (err) {
    console.warn("Could not sample cover image color, using default palette.", err);
  }
}

function extractDominantRgb(imageUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 48;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          reject(new Error("2d context unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 24) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
        if (n === 0) {
          reject(new Error("no opaque pixels"));
          return;
        }
        resolve([round(r / n), round(g / n), round(b / n)]);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("image load failed"));
    img.src = imageUrl;
  });
}

function loadSoundFromUrl(audioUrl, tokenId) {
  if (sound) {
    sound.stop();
    sound.disconnect();
  }
  sound = loadSound(
    audioUrl,
    () => {
      sound.setLoop(true);
      sound.setVolume(0);
      fft.setInput(sound);
      const label = currentObjktName
        ? '"' + currentObjktName + '" (OBJKT #' + tokenId + ")"
        : "OBJKT #" + tokenId;
      if (objktMetaEl) {
        objktMetaEl.innerHTML =
          'Now Visualising: <a href="' +
          tokenObjktUrl(tokenId) +
          '" target="_blank" rel="noopener noreferrer">' +
          label +
          "</a>";
      }
      startSoundAfterGesture();
    },
    (err) => {
      if (objktMetaEl) objktMetaEl.textContent = "Now Visualising: failed to decode OBJKT audio.";
      console.error(err);
    }
  );
}

function startSoundAfterGesture() {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state !== "running") {
    ctx.resume().catch(() => {});
  }
  if (ctx.state === "running" && sound && !sound.isPlaying()) {
    sound.play();
    audioLoaded = true;
    needsGestureToStart = false;
  } else if (ctx.state !== "running") {
    needsGestureToStart = true;
  }
}

function rotateHue(rgb, hueShiftDeg) {
  const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const shiftedHue = (hsv.h + hueShiftDeg + 360) % 360;
  const out = hsvToRgb(shiftedHue, hsv.s, hsv.v);
  return [out[0], out[1], out[2]];
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
