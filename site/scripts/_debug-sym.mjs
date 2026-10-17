import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { tracePath } from './trace.mjs';

const buf = readFileSync(new URL('../../Logo/Symbol/4x/Artboard 1@4x.png', import.meta.url));
const { width, height, bbox } = await tracePath(buf);
const { data } = await sharp(buf).extract({ left: bbox.x, top: bbox.y, width, height })
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

const hist = new Array(8).fill(0);
for (let i = 0; i < width * height; i++) {
  hist[Math.floor(data[i * 4 + 3] / 32)]++;
}
console.log('alpha/32 histogram:', hist, 'total', width * height);
console.log('(0 = transparent, 7 = opaque)');

// render the alpha mask as ASCII (ink = '#')
const cols = 60, rows = Math.max(4, Math.round(cols * height / width * 0.5));
const { data: small } = await sharp(buf).extract({ left: bbox.x, top: bbox.y, width, height })
  .resize(cols, rows, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let art = '';
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    const a = small[(y * cols + x) * 4 + 3];
    art += a > 192 ? '#' : a > 128 ? '+' : a > 64 ? '.' : ' ';
  }
  art += '\n';
}
console.log(art);

// also the RGB of the most opaque pixels
const px = {};
for (let i = 0; i < width * height; i++) {
  if (data[i * 4 + 3] > 200) {
    const k = `${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]}`;
    px[k] = (px[k] || 0) + 1;
  }
}
console.log('opaque RGB colours:', Object.entries(px).sort((a, b) => b[1] - a[1]).slice(0, 6));
