import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { tracePath } from './trace.mjs';

const buf = readFileSync(new URL('../../Logo/Symbol/4x/Artboard 1@4x.png', import.meta.url));
const { width, height, bbox } = await tracePath(buf);
const cols = 100, rows = Math.round(cols * height / width * 0.5);
const { data } = await sharp(buf).extract({ left: bbox.x, top: bbox.y, width, height })
  .resize(cols, rows, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let art = '';
for (let y = 0; y < rows; y++) {
  for (let x = 0; x < cols; x++) {
    art += data[(y * cols + x) * 4 + 3] > 128 ? '#' : '.';
  }
  art += '\n';
}
console.log(`symbol source ${width}x${height} (aspect ${(width / height).toFixed(3)})\n` + art);
