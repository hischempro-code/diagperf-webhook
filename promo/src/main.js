/**
 * Point d'entrée : charge polices/images, construit la timeline et le fond, puis
 *  - mode lecture (défaut) : horloge rAF, contrôles, scrub, raccourcis clavier ;
 *  - mode rendu (?render=1) : pas d'horloge, la frame t est imposée par
 *    window.__seek(t) depuis scripts/render.mjs (export MP4 image par image).
 */
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/700.css";
import "./style.css";

import { buildTimeline } from "./timeline.js";
import { createBackground } from "./background.js";
import { DURATION, MARKERS } from "./scenes.js";

const RENDER = new URLSearchParams(location.search).has("render");
if (RENDER) document.body.classList.add("render");

const stage = document.getElementById("stage");
const stageBox = document.getElementById("stageBox");

function fit() {
  if (RENDER) {
    stage.style.transform = "none";
    stageBox.style.width = "1080px";
    stageBox.style.height = "1920px";
    return;
  }
  const s = Math.min((innerWidth - 32) / 1080, (innerHeight - 110) / 1920);
  stage.style.transform = `scale(${s})`;
  stageBox.style.width = `${1080 * s}px`;
  stageBox.style.height = `${1920 * s}px`;
}

async function boot() {
  fit();
  addEventListener("resize", fit);

  // Les mesures de la timeline (hauteur des bulles → scroll du chat) exigent les
  // vraies polices : on attend explicitement chaque graisse utilisée.
  await Promise.all([
    document.fonts.load('400 30px "Inter"'),
    document.fonts.load('500 30px "Inter"'),
    document.fonts.load('600 30px "Inter"'),
    document.fonts.load('700 30px "Inter"'),
    document.fonts.load('600 80px "Space Grotesk"'),
    document.fonts.load('700 80px "Space Grotesk"'),
    document.fonts.load('700 200px "JetBrains Mono"'),
  ]);
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));

  const bg = createBackground(document.getElementById("bg"));
  const { tl, frame } = buildTimeline();

  const renderAt = (t) => {
    tl.time(t);
    frame(t);
    bg.draw(t);
  };

  if (RENDER) {
    renderAt(0);
    window.__duration = DURATION;
    window.__seek = (t) =>
      new Promise((resolve) => {
        renderAt(t);
        // 2 rAF : garantit que le style et le canvas sont peints avant la capture
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    window.__ready = true;
    return;
  }

  // ── Lecteur ───────────────────────────────────────────────────────────────
  const ui = {
    play: document.getElementById("play"),
    sound: document.getElementById("sound"),
    time: document.getElementById("time"),
    scrub: document.getElementById("scrub"),
    speed: document.getElementById("speed"),
    loop: document.getElementById("loop"),
    fps: document.getElementById("fps"),
    markers: document.getElementById("markers"),
  };
  ui.scrub.max = String(DURATION);

  let t = 0;
  let playing = true;
  let last = null;
  let dirty = true;
  let fpsFrames = 0;
  let fpsT0 = performance.now();

  // ── Bande-son (générée par `npm run audio`) ────────────────────────────
  // Quand elle joue, l'horloge AUDIO pilote l'image (synchro labiale exacte) ;
  // sinon (fichier absent, son coupé, autoplay bloqué) on retombe sur rAF.
  const audio = new Audio(`/out/audio/soundtrack.wav?v=${Date.now()}`);
  audio.preload = "auto";
  let audioReady = false;
  let soundOn = true;
  let audioBlocked = false;
  let playPending = false;
  audio.addEventListener("canplay", () => { audioReady = true; });
  audio.addEventListener("error", () => { audioReady = false; ui.sound.title = "Pas de bande-son : lancez npm run audio"; ui.sound.textContent = "∅"; });
  const audioDrives = () => audioReady && soundOn && !audio.paused && !audio.seeking;
  const updateSoundBtn = () => {
    ui.sound.textContent = soundOn ? "🔊" : "🔇";
    ui.sound.classList.toggle("blocked", audioBlocked && soundOn);
    if (audioBlocked && soundOn) ui.sound.title = "Le navigateur a bloqué le son : cliquez pour l'activer";
  };
  const syncAudio = () => {
    if (!audioReady) return;
    if (!playing || !soundOn) { if (!audio.paused) audio.pause(); return; }
    audio.playbackRate = parseFloat(ui.speed.value);
    if (Math.abs(audio.currentTime - t) > 0.08) audio.currentTime = t;
    if (audio.paused && !audioBlocked && !playPending) {
      playPending = true; // un seul play() à la fois ; s'il est refusé, on attend un clic
      audio.play()
        .then(() => { audioBlocked = false; updateSoundBtn(); })
        .catch(() => { audioBlocked = true; updateSoundBtn(); })
        .finally(() => { playPending = false; });
    }
  };

  const setPlaying = (p) => {
    playing = p;
    ui.play.textContent = p ? "❚❚" : "▶";
    last = null;
    syncAudio();
  };
  const seek = (v) => {
    t = Math.min(Math.max(v, 0), DURATION);
    if (audioReady) audio.currentTime = t;
    dirty = true;
  };
  ui.sound.addEventListener("click", () => {
    soundOn = audioBlocked ? true : !soundOn;
    audioBlocked = false;
    updateSoundBtn();
    syncAudio();
  });

  for (const [label, at] of MARKERS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.left = `${(at / DURATION) * 100}%`;
    b.addEventListener("click", () => seek(at));
    ui.markers.appendChild(b);
  }

  ui.play.addEventListener("click", () => {
    if (!playing && t >= DURATION) seek(0);
    setPlaying(!playing);
  });
  ui.scrub.addEventListener("input", () => {
    setPlaying(false);
    seek(parseFloat(ui.scrub.value));
  });
  addEventListener("keydown", (e) => {
    if (e.code === "Space") { e.preventDefault(); ui.play.click(); }
    else if (e.code === "ArrowRight") { setPlaying(false); seek(t + (e.shiftKey ? 1 : 1 / 60)); }
    else if (e.code === "ArrowLeft") { setPlaying(false); seek(t - (e.shiftKey ? 1 : 1 / 60)); }
    else if (e.code === "Home") seek(0);
    else if (e.code === "KeyM") ui.sound.click();
  });

  function tick(now) {
    if (playing) {
      if (audioDrives()) t = audio.ended ? DURATION : audio.currentTime;
      else if (last !== null) t += Math.min((now - last) / 1000, 0.1) * parseFloat(ui.speed.value);
      if (t >= DURATION - 0.004) {
        if (ui.loop.checked) seek(0);
        else { t = DURATION; setPlaying(false); }
      }
      last = now;
      dirty = true;
      syncAudio();
    }
    if (dirty) {
      renderAt(t);
      ui.time.textContent = `${t.toFixed(2)} / ${DURATION.toFixed(2)}`;
      ui.scrub.value = String(t);
      dirty = false;
    }
    fpsFrames++;
    if (now - fpsT0 >= 500) {
      ui.fps.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsT0))} fps`;
      fpsFrames = 0;
      fpsT0 = now;
    }
    requestAnimationFrame(tick);
  }
  setPlaying(true);
  requestAnimationFrame(tick);
}

boot();
