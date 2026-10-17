import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const p = (u) => fileURLToPath(u);

const src = await sharp(p(new URL('../Logo/Text/4x/Artboard 1@4x.png', ROOT))).trim({ threshold: 8 }).png().toBuffer();
const meta = await sharp(src).metadata();
const svg = readFileSync(p(new URL('public/brand/wordmark.svg', ROOT)), 'utf8').replaceAll('currentColor', '#FFFFFF');
const mine = await sharp(Buffer.from(svg)).resize(meta.width, meta.height, { fit: 'fill' }).png().toBuffer();

const get = async (buf) => {
  const { data, info } = await sharp(buf).resize(meta.width, meta.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { d: data, w: info.width, h: info.height };
};
const A = await get(src), B = await get(mine);

function spans(img, y) {
  const runs = []; let inRun = false, s = 0;
  for (let x = 0; x < img.w; x++) {
    const lit = img.d[(y * img.w + x) * 4 + 3] > 128;
    if (lit && !inRun) { inRun = true; s = x; }
    else if (!lit && inRun) { inRun = false; runs.push(`${s}-${x - 1}`); }
  }
  if (inRun) runs.push(`${s}-${img.w - 1}`);
  return runs.join('  ') || '(none)';
}
console.log(`wordmark ${meta.width}x${meta.height}   [SRC]           vs   [MINE]`);
for (let y = 0; y < meta.height; y++) {
  console.log(`y=${String(y).padStart(2)}  ${spans(A, y).padEnd(26)} | ${spans(B, y)}`);
}
