// Marching-squares alpha tracer: PNG (with transparency) -> SVG path data.
// The owner's logo PNGs are only 64x32 / 100x148, too soft for retina, so we
// vectorise them once and ship crisp, themeable SVG instead.
//
// tracePath(buf, opts) -> { d, width, height, bbox, loops, points }
//   d      : SVG path data, coordinates in the trimmed ink-box pixel space
//   width  : viewBox width  ("0 0 width height")
//   height : viewBox height
//   bbox   : ink bounding box within the source image ({ x, y })
//   loops  : number of closed subpaths; points: total vertices
//
// NOTE: multi-contour shapes (e.g. the Symbol) can nest, so render the output
// with fill-rule="evenodd" — see gen-brand.mjs.
import sharp from 'sharp';

// Douglas–Peucker on a point list. Tolerant of closed rings (which arrive with
// duplicated/repeated vertices that would otherwise produce a zero-length
// baseline, collapsing the whole ring to two points).
export const RDP = (pts, eps) => {
  if (!pts || pts.length < 3) return pts;
  // drop consecutive duplicates
  const src = [];
  for (const p of pts) {
    const q = src[src.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) src.push(p);
  }
  // strip trailing points that duplicate the head so the ring is open
  while (src.length > 3 && src[0][0] === src[src.length - 1][0] && src[0][1] === src[src.length - 1][1]) src.pop();
  if (src.length < 3) return src;
  const n = src.length;
  const keep = new Array(n).fill(false);
  keep[0] = keep[n - 1] = true;
  const d2 = (i, j) => (src[j][0] - src[i][0]) ** 2 + (src[j][1] - src[i][1]) ** 2;

  const stack = [[0, n - 1]];
  if (d2(0, n - 1) < 1e-9) {
    // endpoints coincide: anchor on the vertex farthest from the start
    let far = -1, fi = -1;
    for (let i = 1; i < n - 1; i++) { const d = d2(0, i); if (d > far) { far = d; fi = i; } }
    if (fi > 0) { keep[fi] = true; stack.push([0, fi], [fi, n - 1]); }
  }
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e <= s + 1) continue;
    const [ax, ay] = src[s], [bx, by] = src[e];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((src[i][0] - ax) * dy - (src[i][1] - ay) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
  }
  return src.filter((_, i) => keep[i]);
};

export async function tracePath(buf, { upsample = 8, epsilon = 0.2, pad = 3, level = 128, trim = true } = {}) {
  // Optionally crop to the ink bounding box so the resulting viewBox hugs the
  // artwork instead of the (mostly empty) source artboard.
  let source = buf;
  const bbox = { x: 0, y: 0 };
  if (trim) {
    const { data: im, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (im[(y * info.width + x) * 4 + 3] >= level) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 >= x0 && y1 >= y0) {
      bbox.x = x0; bbox.y = y0;
      source = await sharp(buf).extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer();
    }
  }
  // pad with transparency so contours close even when ink touches the border
  const padded = await sharp(source).ensureAlpha()
    .extend({ top: pad, left: pad, bottom: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const pm = await sharp(padded).metadata();
  const W = Math.round(pm.width * upsample), H = Math.round(pm.height * upsample);
  const { data } = await sharp(padded).resize(W, H, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const A = (x, y) => data[(y * W + x) * 4 + 3];
  const t = (u, v) => (u === v ? 0.5 : (level - u) / (v - u));
  const keyH = (i, j) => `h:${i}:${j}`;
  const keyV = (i, j) => `v:${i}:${j}`;

  const segs = [];
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = A(i, j), b = A(i + 1, j), c = A(i + 1, j + 1), d = A(i, j + 1);
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = { k: keyH(i, j),     x: i + t(a, b), y: j };
      const R = { k: keyV(i + 1, j), x: i + 1,       y: j + t(b, c) };
      const B = { k: keyH(i, j + 1), x: i + t(d, c), y: j + 1 };
      const L = { k: keyV(i, j),     x: i,           y: j + t(a, d) };
      const push = (p, q) => segs.push([p, q]);
      switch (idx) {
        case 1: push(L, B); break;
        case 2: push(B, R); break;
        case 3: push(L, R); break;
        case 4: push(T, R); break;
        case 6: push(T, B); break;
        case 7: push(L, T); break;
        case 8: push(T, L); break;
        case 9: push(T, B); break;
        case 11: push(T, R); break;
        case 12: push(L, R); break;
        case 13: push(B, R); break;
        case 14: push(L, B); break;
        case 5: { // b,d inside (a,c outside)
          const cen = (a + b + c + d) / 4;
          if (cen > level) { push(L, T); push(B, R); } else { push(T, R); push(B, L); }
          break;
        }
        case 10: { // a,c inside (b,d outside)
          const cen = (a + b + c + d) / 4;
          if (cen > level) { push(T, R); push(B, L); } else { push(T, L); push(B, R); }
          break;
        }
      }
    }
  }

  // stitch: every grid-line key is shared by exactly two segment endpoints
  const at = new Map();
  segs.forEach(([p, q], si) => {
    if (!at.has(p.k)) at.set(p.k, []);
    at.get(p.k).push(si);
    if (!at.has(q.k)) at.set(q.k, []);
    at.get(q.k).push(si);
  });

  const used = new Array(segs.length).fill(false);
  const loops = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = true;
    const loop = [segs[s0][0], segs[s0][1]];
    let cur = segs[s0][1];
    for (let guard = 0; guard < segs.length + 5; guard++) {
      const cands = (at.get(cur.k) || []).filter(si => !used[si]);
      if (cands.length === 0) break;
      const si = cands[0];
      used[si] = true;
      const [p, q] = segs[si];
      const other = p.k === cur.k ? q : p;
      loop.push(other);
      cur = other;
      if (cur.k === segs[s0][0].k) break; // closed
    }
    loops.push(loop);
  }

  // to source-pixel coords (undo padding + upsample)
  const conv = (p) => [ (p.x - pad * upsample) / upsample, (p.y - pad * upsample) / upsample ];
  const parts = [];
  let ptsOut = 0;
  for (const loop of loops) {
    const poly = loop.map(conv);
    const simp = RDP(poly, epsilon);
    if (simp.length < 3) continue;
    ptsOut += simp.length;
    const seg = simp.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    parts.push(`${seg} Z`);
  }
  const w = pm.width - pad * 2, h = pm.height - pad * 2;
  return { d: parts.join(' '), width: w, height: h, bbox, loops: parts.length, points: ptsOut };
}
