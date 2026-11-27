/**
 * Capture docs/demo/storyboard.html scenes → docs/demo/frameparse-demo.gif
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import gifenc from "gifenc";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
const { GIFEncoder, quantize, applyPalette } = gifenc;
const ffmpegPath = { path: ffmpegInstaller.path || ffmpegInstaller };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const framesDir = path.join(__dirname, "frames");
const outGif = path.join(__dirname, "frameparse-demo.gif");
const outMp4 = path.join(__dirname, "frameparse-demo.mp4");
const storyboard = path.join(__dirname, "storyboard.html");

mkdirSync(framesDir, { recursive: true });

const scenes = [
  { id: 0, holdMs: 1600 },
  { id: 1, holdMs: 1800 },
  { id: 2, holdMs: 1800 },
  { id: 3, holdMs: 2000 },
  { id: 4, holdMs: 2200 },
  { id: 5, holdMs: 2000 },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(storyboard).href, { waitUntil: "networkidle" });

const pngPaths = [];
for (const scene of scenes) {
  await page.evaluate((n) => window.__setScene(n), scene.id);
  await page.waitForTimeout(80);
  // duplicate frames for duration (~10fps)
  const copies = Math.max(1, Math.round(scene.holdMs / 100));
  const base = path.join(framesDir, `scene-${scene.id}.png`);
  await page.screenshot({ path: base, type: "png" });
  for (let i = 0; i < copies; i++) {
    const p = path.join(framesDir, `f-${String(scene.id).padStart(2, "0")}-${String(i).padStart(3, "0")}.png`);
    writeFileSync(p, readFileSync(base));
    pngPaths.push(p);
  }
}
await browser.close();

// Build GIF with gifenc
const gif = GIFEncoder();
let w = 0;
let h = 0;
for (const p of pngPaths) {
  const png = PNG.sync.read(readFileSync(p));
  w = png.width;
  h = png.height;
  const palette = quantize(png.data, 256);
  const index = applyPalette(png.data, palette);
  gif.writeFrame(index, w, h, { palette, delay: 100 });
}
gif.finish();
writeFileSync(outGif, Buffer.from(gif.bytes()));

// Also MP4 via ffmpeg if available (nice for LinkedIn/X)
const listFile = path.join(framesDir, "list.txt");
writeFileSync(
  listFile,
  readdirSync(framesDir)
    .filter((f) => /^f-/.test(f))
    .sort()
    .map((f) => `file '${f.replace(/\\/g, "/")}'\nduration 0.1`)
    .join("\n") + `\nfile '${readdirSync(framesDir).filter((f) => /^f-/.test(f)).sort().at(-1)}'`,
);
const ff = spawnSync(
  ffmpegPath.path,
  [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-vf",
    "fps=10,format=yuv420p",
    outMp4,
  ],
  { cwd: framesDir, encoding: "utf8" },
);

console.log(
  JSON.stringify(
    {
      gif: outGif,
      gifBytes: readFileSync(outGif).length,
      mp4: ff.status === 0 ? outMp4 : null,
      frames: pngPaths.length,
      size: `${w}x${h}`,
      ffmpegError: ff.status === 0 ? null : (ff.stderr || ff.stdout || "").slice(-400),
    },
    null,
    2,
  ),
);
