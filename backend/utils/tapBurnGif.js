// backend/utils/tapBurnGif.js
//
// Builds the "burning" GIF shown while a tap is broadcasting: the Electroneum logo with flames
// rising from its base. Built once at startup and reused for every tap. The flames use a fixed seed
// so the loop is identical each time it's generated.
import { createCanvas, loadImage } from "canvas";
import gifenc from "gifenc";
import path from "path";
import { fileURLToPath } from "url";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "..", "assets", "Electroneum.png");
const WIDTH = 640;
const HEIGHT = 240;
const LOGO_HEIGHT = 150;
const FRAMES = 16;
const FRAME_DELAY_MS = 70;
const PARTICLES = 110;
const FLAME_RISE_PX = 150;

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export async function buildBurnGif() {
  const logo = await loadImage(LOGO_PATH);
  const logoWidth = (logo.width / logo.height) * LOGO_HEIGHT;
  const logoX = (WIDTH - logoWidth) / 2;
  const logoY = (HEIGHT - LOGO_HEIGHT) / 2 - 10;
  const flameBaseY = logoY + LOGO_HEIGHT;

  const rand = seededRandom(52014);
  const particles = Array.from({ length: PARTICLES }, () => ({
    x: logoX + rand() * logoWidth,
    offset: rand(),
    size: 9 + rand() * 14,
    drift: (rand() - 0.5) * 0.6,
    rise: 0.6 + rand() * 0.4,
  }));

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const encoder = GIFEncoder();

  for (let frame = 0; frame < FRAMES; frame++) {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0b0b14";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(logo, logoX, logoY, logoWidth, LOGO_HEIGHT);

    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      const age = ((frame / FRAMES) + p.offset) % 1;
      const x = p.x + Math.sin(age * 6 + p.offset * 10) * 8 + p.drift * age * 30;
      const y = flameBaseY - age * FLAME_RISE_PX * p.rise;
      const radius = p.size * (1 - age * 0.7);
      const color = age < 0.35 ? "255,230,90" : age < 0.7 ? "255,140,0" : "220,40,20";
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      gradient.addColorStop(0, `rgba(${color},${1 - age})`);
      gradient.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    encoder.writeFrame(index, WIDTH, HEIGHT, { palette, delay: FRAME_DELAY_MS });
  }

  encoder.finish();
  return Buffer.from(encoder.bytes());
}
