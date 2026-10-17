import fs from 'node:fs';
import { tracePath } from './trace.mjs';

const buf = fs.readFileSync(new URL('../../Logo/Text/4x/Artboard 1@4x.png', import.meta.url));
for (const eps of [0.3, 1, 2, 4]) {
  const r = await tracePath(buf, { epsilon: eps });
  console.log('eps', eps, { loops: r.loops, points: r.points, w: r.width, h: r.height, dLen: r.d.length });
}
const sym = fs.readFileSync(new URL('../../Logo/Symbol/4x/Artboard 1@4x.png', import.meta.url));
for (const eps of [0.3, 1, 2, 4]) {
  const r = await tracePath(sym, { epsilon: eps });
  console.log('SYM eps', eps, { loops: r.loops, points: r.points, w: r.width, h: r.height });
}
