import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { tracePath } from './trace.mjs';

for (const [name, rel] of [['Text', '../../Logo/Text/4x/Artboard 1@4x.png'], ['Symbol', '../../Logo/Symbol/4x/Artboard 1@4x.png']]) {
  const buf = readFileSync(new URL(rel, import.meta.url));
  const { d, width, height, bbox } = await tracePath(buf);
  const ref = await sharp(buf).extract({ left: bbox.x, top: bbox.y, width, height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const rule of ['nonzero', 'evenodd']) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${d}" fill="#000" fill-rule="${rule}"/></svg>`;
    const re = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let mismatch = 0, total = width * height;
    for (let i = 0; i < total; i++) {
      if (Math.abs(ref.data[i * 4 + 3] - re.data[i * 4 + 3]) > 32) mismatch++;
    }
    console.log(`${name.padEnd(7)} ${rule.padEnd(8)} mismatch ${(100 * mismatch / total).toFixed(3)}%`);
  }
}
