import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { tracePath } from './trace.mjs';

const CASES = [['Text', '../../Logo/Text/4x/Artboard 1@4x.png'], ['Symbol', '../../Logo/Symbol/4x/Artboard 1@4x.png']];

for (const [name, rel] of CASES) {
  const buf = readFileSync(new URL(rel, import.meta.url));
  console.log(`\n${name}`);
  for (const upsample of [8, 12, 16]) {
    for (const epsilon of [0.2, 0.3, 0.5]) {
      const t0 = Date.now();
      const { d, width, height, bbox, points } = await tracePath(buf, { upsample, epsilon });
      const ref = await sharp(buf).extract({ left: bbox.x, top: bbox.y, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${d}" fill="#000" fill-rule="evenodd"/></svg>`;
      const re = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let mm = 0;
      for (let i = 0; i < width * height; i++) if (Math.abs(ref.data[i * 4 + 3] - re.data[i * 4 + 3]) > 32) mm++;
      console.log(`  up=${String(upsample).padStart(2)} eps=${epsilon}  mm=${(100 * mm / (width * height)).toFixed(3)}%  pts=${points}  ${Date.now() - t0}ms`);
    }
  }
}
