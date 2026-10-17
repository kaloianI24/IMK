import fs from 'node:fs';
import sharp from 'sharp';
import { tracePath } from './trace.mjs';

const buf = fs.readFileSync(new URL('../../Logo/Text/4x/Artboard 1@4x.png', import.meta.url));

// replicate the segment-generation stage to count what's happening
const upsample = 8, pad = 3, level = 128;
const padded = await sharp(buf).ensureAlpha()
  .extend({ top: pad, left: pad, bottom: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();
const pm = await sharp(padded).metadata();
const W = Math.round(pm.width * upsample), H = Math.round(pm.height * upsample);
const { data } = await sharp(padded).resize(W, H, { fit: 'fill', kernel: 'lanczos3' })
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const A = (x, y) => data[(y * W + x) * 4 + 3];

let above = 0, cells = 0;
const hist = {};
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const a = A(i, j);
  if (a > level) above++;
  const b = Math.floor(a / 32) * 32;
  hist[b] = (hist[b] || 0) + 1;
}
console.log({ W, H, above, cells: W * H });
console.log('alpha histogram (bucket: count):', hist);
// count marching-squares segments
const t = (u, v) => (u === v ? 0.5 : (level - u) / (v - u));
let segs = 0;
const idxHist = {};
for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
  const a = A(i, j), b = A(i + 1, j), c = A(i + 1, j + 1), d = A(i, j + 1);
  const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
  idxHist[idx] = (idxHist[idx] || 0) + 1;
  if (idx === 0 || idx === 15) continue;
  segs += idx === 5 || idx === 10 ? 2 : 1;
}
console.log({ segs, idxHist });

console.log('trace:', await tracePath(buf, { upsample: 8 }));
console.log('trace upsample4:', await tracePath(buf, { upsample: 4 }));
