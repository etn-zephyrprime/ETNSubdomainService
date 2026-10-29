// backend/scripts/renderArgusLogo.js
//
// Renders the Argus logo PNG used on the Argus Telegram alerts (assets/ArgusLogo.png) — a still of
// the dashboard's own header (src/dashboard/DashboardApp.jsx): "Argus" in Orbitron Bold with the
// layered white/green glow, the eight scattered "Argus Panoptes" eyes, on the dashboard's dark
// background with its green and blue corner glows. Re-run after changing the header's look:
//   node scripts/renderArgusLogo.js
import { createCanvas, registerFont } from "canvas";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
registerFont(path.join(here, "..", "fonts", "Orbitron-Bold.ttf"), { family: "Orbitron", weight: "bold" });

const W = 1280, H = 480;
const GREEN = "#18bb1a", GREEN_GLOW = "rgba(24,187,26,0.35)", BLUE_GLOW = "rgba(0,198,255,0.25)";
const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");

// Background: the dashboard's radial gradient, then its two soft corner glows.
const bg = ctx.createRadialGradient(W / 2, -0.1 * H, 0, W / 2, -0.1 * H, W * 0.8);
bg.addColorStop(0, "#0c1512");
bg.addColorStop(0.5, "#070d0a");
bg.addColorStop(1, "#050908");
ctx.fillStyle = bg;
ctx.fillRect(0, 0, W, H);
for (const [x, y, r, c] of [[W * 0.08, H * 0.1, 420, GREEN_GLOW], [W * 0.95, H * 0.55, 400, BLUE_GLOW]]) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, c);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// Title, scaled from the header's 48px desktop size.
const SCALE = 3.4;
const fontPx = 48 * SCALE;
ctx.font = `bold ${fontPx}px Orbitron`;
const text = "Argus";
const letter = 1.5 * SCALE;
const widths = [...text].map((ch) => ctx.measureText(ch).width);
const textW = widths.reduce((a, b) => a + b, 0) + letter * (text.length - 1);
const x0 = (W - textW) / 2;
const baseline = H / 2 + fontPx * 0.36;
const drawText = () => {
  let x = x0;
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, x, baseline);
    x += widths[i] + letter;
  });
};
ctx.fillStyle = "#fff";
// The header's layered text-shadow: 0 0 4px #fff, 0 0 10px green, 0 0 26px glow, 0 0 48px glow.
for (const [blur, color] of [[48, GREEN_GLOW], [26, GREEN_GLOW], [10, GREEN], [4, "#fff"]]) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * SCALE;
  drawText();
}
ctx.shadowBlur = 0;
drawText();

// The eight eyes — the header's positions/sizes/rotations/opacity, relative to the title box
// (the title sits in a box padded 28px either side).
const boxLeft = x0 - 28 * SCALE, boxRight = x0 + textW + 28 * SCALE, boxTop = baseline - fontPx * 0.95, boxW = boxRight - boxLeft;
const eyes = [
  { top: -10, left: -6, size: 11, rotate: -18, opacity: 0.85 },
  { top: 2, left: -26, size: 9, rotate: 8, opacity: 0.55 },
  { top: 22, left: -18, size: 10, rotate: -6, opacity: 0.65 },
  { top: -14, leftPct: 0.38, size: 9, rotate: 14, opacity: 0.5 },
  { top: -8, right: -8, size: 12, rotate: 16, opacity: 0.85 },
  { top: 4, right: -28, size: 9, rotate: -10, opacity: 0.55 },
  { top: 24, right: -16, size: 10, rotate: 5, opacity: 0.65 },
  { top: -14, rightPct: 0.36, size: 9, rotate: -12, opacity: 0.5 },
];
function drawEye(cx, cy, size, rotateDeg, opacity) {
  // Lucide "eye": an almond outline and a round pupil, stroke 2 on a 24-unit grid.
  const s = size / 24;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((rotateDeg * Math.PI) / 180);
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 2 * s;
  ctx.lineCap = "round";
  ctx.shadowColor = GREEN_GLOW;
  ctx.shadowBlur = 3 * SCALE;
  ctx.beginPath();
  ctx.moveTo(-10 * s, 0);
  ctx.quadraticCurveTo(0, -11 * s, 10 * s, 0);
  ctx.quadraticCurveTo(0, 11 * s, -10 * s, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 3 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
for (const e of eyes) {
  const size = e.size * SCALE;
  const y = boxTop + e.top * SCALE + size / 2;
  const x = e.left != null ? boxLeft + e.left * SCALE + size / 2
    : e.leftPct != null ? boxLeft + e.leftPct * boxW + size / 2
    : e.right != null ? boxRight - e.right * SCALE - size / 2
    : boxRight - e.rightPct * boxW - size / 2;
  drawEye(x, y, size, e.rotate, e.opacity);
}

const out = path.join(here, "..", "assets", "ArgusLogo.png");
writeFileSync(out, canvas.toBuffer("image/png"));
console.log(`✅ wrote ${out} (${W}x${H})`);
