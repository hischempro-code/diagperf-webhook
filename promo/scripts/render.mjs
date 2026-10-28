/**
 * Export MP4 image par image — rendu identique à la prévisualisation.
 *
 *   npm run render                → out/diagperf-promo.mp4 (30 fps)
 *   npm run render -- --fps 60    → 60 fps
 *   npm run render -- --still 2.5,11,25  → captures PNG (contrôle visuel rapide)
 *
 * Pipeline : serveur Vite embarqué → navigateur headless (Edge ou Chrome déjà
 * installés, via playwright-core : aucun navigateur téléchargé) → pour chaque
 * frame, window.__seek(t) puis capture PNG → pipe vers ffmpeg (H.264, yuv420p,
 * faststart : lisible partout, Instagram/TikTok/WhatsApp compris).
 */
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const fps = parseInt(arg("fps", "30"), 10);
const stills = arg("still", null);
const outFile = path.resolve(root, arg("out", path.join("out", fps === 30 ? "diagperf-promo.mp4" : `diagperf-promo-${fps}fps.mp4`)));

async function launchBrowser() {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
    } catch { /* on essaie le suivant */ }
  }
  throw new Error("Aucun navigateur Edge/Chrome trouvé pour le rendu headless.");
}

const server = await createServer({ root, logLevel: "error", server: { port: 5199, strictPort: false } });
await server.listen();
const url = `${server.resolvedUrls.local[0]}?render=1`;

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("Erreur page :", e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
  const duration = await page.evaluate(() => window.__duration);
  const shot = () => page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1080, height: 1920 } });

  if (stills) {
    for (const s of stills.split(",").map(Number)) {
      await page.evaluate((t) => window.__seek(t), s);
      const file = path.join(outDir, `still-${s.toFixed(2)}.png`);
      writeFileSync(file, await shot());
      console.log("✔", path.relative(root, file));
    }
  } else {
    const total = Math.round(duration * fps);
    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "16",
      "-pix_fmt", "yuv420p", "-profile:v", "high", "-movflags", "+faststart",
      outFile,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const ffDone = once(ff, "close");

    const t0 = Date.now();
    for (let f = 0; f < total; f++) {
      await page.evaluate((t) => window.__seek(t), f / fps);
      const buf = await shot();
      if (!ff.stdin.write(buf)) await once(ff.stdin, "drain");
      if (f % fps === 0 || f === total - 1) {
        const pct = (((f + 1) / total) * 100).toFixed(0).padStart(3);
        const eta = (((Date.now() - t0) / (f + 1)) * (total - f - 1) / 1000).toFixed(0);
        process.stdout.write(`\r  rendu ${pct}%  (${f + 1}/${total} frames, ~${eta}s restantes)   `);
      }
    }
    ff.stdin.end();
    const [code] = await ffDone;
    if (code !== 0) throw new Error(`ffmpeg a échoué (code ${code})`);
    console.log(`\n✔ ${path.relative(root, outFile)} — ${total} frames, ${fps} fps, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
} finally {
  await browser.close();
  await server.close();
}
