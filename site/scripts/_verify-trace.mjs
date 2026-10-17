// Verify trace.mjs: trace a PNG -> rasterise the SVG -> diff alpha vs the
// source cropped to the exact same ink bbox. Prints an ASCII render.
// Usage: node scripts\_verify-trace.mjs
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { tracePath } from './trace.mjs';

const CASES = [
  ['Text',   '../../Logo/Text/4x/Artboard 1@4x.png'],
  ['Symbol', '../../Logo/Symbol/4x/Artboard 1@4x.png'],
];

for (const [name, rel] of CASES) {
  const buf = readFileSync(new URL(rel, import.meta.url));
  const { d, width, height, bbox, loops, points } = await tracePath(buf);
  console.log(`\n== ${name}: viewBox 0 0 ${width} ${height}  loops=${loops} points=${points} d=${d.length}ch`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${d}" fill="#000"/></svg>`;

  // reference = source cropped to the tracer's own bbox
  const ref = await sharp(buf)
    .extract({ left: bbox.x, top: bbox.y, width, height })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const re = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  let mismatch = 0, total = width * height, maxDiff = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = ref.data[(y * width + x) * 4 + 3];
      const b = re.data[(y * width + x) * 4 + 3];
      const diff = Math.abs(a - b);
      if (diff > 32) mismatch++;
      if (diff > maxDiff) maxDiff = diff;
    }
  }
  console.log(`  mismatch(>12.5% alpha): ${(100 * mismatch / total).toFixed(3)}%  maxAlphaDiff=${maxDiff}`);

  const cols = 76, rows = Math.max(4, Math.round(cols * height / width * 0.5));
  const small = await sharp(Buffer.from(svg))
    .resize(cols, rows, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .greyscale().raw().toBuffer();
  let art = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = small[y * cols + x];
      art += v > 170 ? '#' : v > 85 ? '+' : v > 20 ? '.' : ' ';
    }
    art += '\n';
  }
  console.log(art);
}
