// Alpha-mask side-by-side: source vs traced path, identical grid.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { tracePath } from './trace.mjs';

const CASES = [
  ['Text',   '../../Logo/Text/4x/Artboard 1@4x.png'],
  ['Symbol', '../../Logo/Symbol/4x/Artboard 1@4x.png'],
];
const cols = 58;

const mask = (buf, w, h) => {
  const rows = Math.max(4, Math.round(cols * h / w * 0.5));
  const out = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const a = buf[(y * cols + x) * 4 + 3];
      line += a > 192 ? '#' : a > 128 ? '+' : a > 64 ? '.' : ' ';
    }
    out.push(line);
  }
  return out;
};

for (const [name, rel] of CASES) {
  const src = readFileSync(new URL(rel, import.meta.url));
  const { d, width, height, bbox } = await tracePath(src);
  const rows = Math.max(4, Math.round(cols * height / width * 0.5));

  const srcSmall = await sharp(src).extract({ left: bbox.x, top: bbox.y, width, height })
    .resize(cols, rows, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${d}" fill="#000"/></svg>`;
  const trcSmall = await sharp(Buffer.from(svg)).resize(cols, rows, { fit: 'fill' })
    .ensureAlpha().raw().toBuffer();

  const a = mask(srcSmall, width, height);
  const b = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      const v = trcSmall[(y * cols + x) * 4 + 3];
      line += v > 192 ? '#' : v > 128 ? '+' : v > 64 ? '.' : ' ';
    }
    b.push(line);
  }
  console.log(`\n=== ${name} (${width}x${height})    SOURCE ${' '.repeat(24)} TRACE`);
  for (let i = 0; i < a.length; i++) console.log(`${a[i]}  |  ${b[i]}`);
}
