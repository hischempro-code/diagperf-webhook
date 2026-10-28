/**
 * Fond Canvas 2D : dégradé nuit, halos rouge/bleu qui dérivent, lignes de vitesse
 * (écho des traînées du logo DiagPerf), vignette et grain film.
 *
 * Déterministe : draw(t) ne dépend QUE de t → identique en lecture live, en
 * scrubbing et en export image par image. Aucun objet alloué par frame : sprites,
 * dégradés et tables sont pré-calculés à l'init.
 */
import { SPEED_KEYS, DURATION } from "./scenes.js";
import { smoothstep } from "./ease.js";

const W = 1080;
const H = 1920;
const LINES = 120;
const PX_PER_UNIT = 420; // px parcourus par seconde à vitesse 1

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speedAt(t) {
  const k = SPEED_KEYS;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 0; i < k.length - 1; i++) {
    const [t0, v0] = k[i];
    const [t1, v1] = k[i + 1];
    if (t < t1) return v0 + (v1 - v0) * smoothstep(t0, t1, t);
  }
  return k[k.length - 1][1];
}

// Distance cumulée = ∫ vitesse dt, tabulée à 240 Hz → la position des lignes
// reste exacte même quand la vitesse varie (pas d'état accumulé entre frames).
const STEP = 1 / 240;
const TABLE_N = Math.ceil((DURATION + 1) / STEP) + 1;
const DIST = new Float64Array(TABLE_N);
for (let i = 1; i < TABLE_N; i++) DIST[i] = DIST[i - 1] + speedAt((i - 0.5) * STEP) * STEP;
function distAt(t) {
  const f = Math.min(Math.max(t / STEP, 0), TABLE_N - 1.001);
  const i = f | 0;
  return DIST[i] + (DIST[i + 1] - DIST[i]) * (f - i);
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function streakSprite(rgb) {
  const c = makeCanvas(512, 8);
  const g = c.getContext("2d");
  // Tête brillante à gauche (les lignes défilent vers la gauche), traîne qui s'efface.
  const grad = g.createLinearGradient(0, 0, 512, 0);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.15, `rgba(${rgb},0.85)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 2, 512, 4);
  g.globalAlpha = 0.35;
  g.fillRect(0, 0, 512, 8);
  return c;
}

function glowSprite(rgba, size = 1100) {
  const c = makeCanvas(size, size);
  const g = c.getContext("2d");
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, rgba);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

function grainTiles(rand, n = 4, size = 256) {
  const tiles = [];
  for (let k = 0; k < n; k++) {
    const c = makeCanvas(size, size);
    const g = c.getContext("2d");
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (rand() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    tiles.push(c);
  }
  return tiles;
}

export function createBackground(canvas) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  const rand = mulberry32(20260923);

  // ── Pré-calculs (une seule fois) ──
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, "#0a0f1e");
  base.addColorStop(0.55, "#070b16");
  base.addColorStop(1, "#05070f");

  const vignette = makeCanvas(W, H);
  {
    const g = vignette.getContext("2d");
    const grad = g.createRadialGradient(W / 2, H * 0.45, H * 0.25, W / 2, H * 0.45, H * 0.75);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.72)");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
  }

  const white = streakSprite("235,240,255");
  const red = streakSprite("239,68,68");
  const glowRed = glowSprite("rgba(220,38,38,0.33)");
  const glowBlue = glowSprite("rgba(59,130,246,0.16)");
  const grain = grainTiles(rand);

  const y = new Float32Array(LINES);
  const x0 = new Float32Array(LINES);
  const len = new Float32Array(LINES);
  const th = new Float32Array(LINES);
  const alpha = new Float32Array(LINES);
  const vel = new Float32Array(LINES);
  const isRed = new Uint8Array(LINES);
  for (let i = 0; i < LINES; i++) {
    y[i] = rand() * H;
    len[i] = 120 + rand() * 420;
    x0[i] = rand() * (W + len[i]) * 4;
    th[i] = 1 + rand() * 2.6;
    vel[i] = 0.55 + rand() * 1.3; // parallaxe : les lignes rapides paraissent plus proches
    isRed[i] = rand() < 0.13 ? 1 : 0;
    alpha[i] = isRed[i] ? 0.25 + rand() * 0.3 : 0.05 + rand() * 0.2;
  }

  function draw(t) {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // Halos qui respirent lentement
    ctx.drawImage(glowRed, 160 + 140 * Math.sin(t * 0.23) - 550, 430 + 110 * Math.cos(t * 0.17) - 550);
    ctx.drawImage(glowBlue, 930 + 120 * Math.cos(t * 0.19) - 550, 1500 + 140 * Math.sin(t * 0.21) - 550);

    // Lignes de vitesse
    const speed = speedAt(t);
    const D = distAt(t) * PX_PER_UNIT;
    const stretch = 1 + Math.min(speed, 10) * 0.2;
    const boost = 0.55 + 0.45 * Math.min(1, speed / 3);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < LINES; i++) {
      const L = len[i] * stretch;
      const span = W + L;
      const x = W - ((x0[i] + vel[i] * D) % span);
      ctx.globalAlpha = Math.min(1, alpha[i] * boost);
      ctx.drawImage(isRed[i] ? red : white, x, y[i] - th[i] * 1.5, L, th[i] * 3);
    }

    // Vignette + grain (le grain change 24×/s, comme une pellicule)
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(vignette, 0, 0);
    const f = Math.floor(t * 24);
    const tile = grain[f & 3];
    const ox = -((f * 61) % 256);
    const oy = -((f * 137) % 256);
    ctx.globalAlpha = 0.055;
    ctx.globalCompositeOperation = "overlay";
    for (let gy = oy; gy < H; gy += 256) {
      for (let gx = ox; gx < W; gx += 256) ctx.drawImage(tile, gx, gy);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  return { draw, speedAt };
}
