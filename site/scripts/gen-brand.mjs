// IXI — brand asset generator.
//
// Source artwork: ../Logo (owner-supplied PNG exports, 1x..4x).
// The PNGs are too low-res to ship (wordmark is only 62x31 px), so the artwork
// is vectorised with scripts/trace.mjs and everything downstream is built from
// the resulting SVG paths.
//
// Outputs:
//   src/brand/logo.ts            traced path data (imported by BrandMark.astro)
//   ../public/favicon.svg        vector favicon (charcoal plate + grey symbol)
//   ../public/favicon-16x16.png  raster fallbacks
//   ../public/favicon-32x32.png
//   ../public/apple-touch-icon.png
//   ../public/android-chrome-{192,512}.png
//   ../public/site.webmanifest
//
// It also acts as the brand accessibility gate: it parses src/styles/tokens.css
// and fails if any brand pair drops below WCAG 2.2 AA (4.5:1 normal text).
//
// Run: npm run brand   (node scripts/gen-brand.mjs)
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tracePath } from './trace.mjs';

const p = (u) => fileURLToPath(u);
const LOGO = new URL('../../Logo/', import.meta.url);
const PUBLIC = new URL('../public/', import.meta.url);
const SRC_BRAND = new URL('../src/brand/', import.meta.url);

// ---------------------------------------------------------------------------
// 0. Colours — measured directly from the owner artwork (see design/brand.md).
//    Wordmark "IXI"  = #720606  (deep red)
//    Symbol mark     = #CCCCCC  (light grey)
//    FullLogo plate  = #222222  (charcoal)
// ---------------------------------------------------------------------------
const BRAND = {
  red: '#720606',      // wordmark colourway (light backgrounds)
  grey: '#CCCCCC',     // symbol colourway (dark backgrounds)
  charcoal: '#222222', // FullLogo plate
  ink: '#F6F1EA',      // light-on-dark ink used by the site's dark theme
};

// ---------------------------------------------------------------------------
// 1. Vectorise the artwork.
// ---------------------------------------------------------------------------
const textPng = readFileSync(new URL('Text/4x/Artboard 1@4x.png', LOGO));
const symbolPng = readFileSync(new URL('Symbol/4x/Artboard 1@4x.png', LOGO));

const wordmark = await tracePath(textPng);
const symbol = await tracePath(symbolPng);
console.log(`wordmark: viewBox 0 0 ${wordmark.width} ${wordmark.height} (${wordmark.loops} loops, ${wordmark.points} pts)`);
console.log(`symbol  : viewBox 0 0 ${symbol.width} ${symbol.height} (${symbol.loops} loops, ${symbol.points} pts)`);

// ---------------------------------------------------------------------------
// 2. src/brand/logo.ts — single source of truth for the inline SVG components.
// ---------------------------------------------------------------------------
mkdirSync(p(SRC_BRAND), { recursive: true });
const logoModule = `// GENERATED FILE — do not edit by hand.
// Produced by scripts/gen-brand.mjs from ../Logo (owner artwork), vectorised by
// scripts/trace.mjs. Run \`npm run brand\` after changing the source artwork.
//
// Render with fill-rule="evenodd": the symbol has nested contours.

export interface LogoPath {
  /** SVG path data, coordinates in the artwork's own pixel space. */
  d: string;
  /** viewBox width. */
  width: number;
  /** viewBox height. */
  height: number;
}

/** Wordmark "IXI" — brand red #720606 in the source artwork. */
export const WORDMARK: LogoPath = { d: ${JSON.stringify(wordmark.d)}, width: ${wordmark.width}, height: ${wordmark.height} };

/** Symbol mark — light grey #CCCCCC in the source artwork. */
export const SYMBOL: LogoPath = { d: ${JSON.stringify(symbol.d)}, width: ${symbol.width}, height: ${symbol.height} };

/** Brand palette measured from the artwork. */
export const BRAND = ${JSON.stringify(BRAND, null, 2)} as const;
`;
writeFileSync(p(new URL('logo.ts', SRC_BRAND)), logoModule);
console.log('src/brand/logo.ts written');

// ---------------------------------------------------------------------------
// 3. App-icon / favicon artwork.
//    Plate + symbol is the legible half of the owner's FullLogo (grey symbol on
//    charcoal = 9.9:1); the red wordmark is unreadable on charcoal (1.3:1), so
//    the icon uses the mark only.
// ---------------------------------------------------------------------------
const iconSvg = (size, { plate = BRAND.charcoal, mark = BRAND.grey } = {}) => {
  const h = +(size * 0.62).toFixed(3);
  const s = h / symbol.height;
  const w = +(symbol.width * s).toFixed(3);
  const x = +((size - w) / 2).toFixed(3);
  const y = +((size - h) / 2).toFixed(3);
  const rx = +(size * 0.22).toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${rx}" fill="${plate}"/>` +
    `<path d="${symbol.d}" fill="${mark}" fill-rule="evenodd" transform="translate(${x} ${y}) scale(${s.toFixed(4)})"/>` +
    `</svg>`;
};

writeFileSync(p(new URL('favicon.svg', PUBLIC)), iconSvg(32) + '\n');
for (const [size, file] of [[16, 'favicon-16x16.png'], [32, 'favicon-32x32.png'], [180, 'apple-touch-icon.png'], [192, 'android-chrome-192x192.png'], [512, 'android-chrome-512x512.png']]) {
  await sharp(Buffer.from(iconSvg(size))).png().toFile(p(new URL(file, PUBLIC)));
}
console.log('favicon.svg + png icons 16/32/180/192/512 written');

// ---------------------------------------------------------------------------
// 4. Web manifest.
// ---------------------------------------------------------------------------
const manifest = {
  name: 'IXI',
  short_name: 'IXI',
  description: 'Automations that still work in month six.',
  icons: [
    { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
  theme_color: BRAND.red,
  background_color: '#F7F1E8',
  display: 'standalone',
  start_url: '/',
};
writeFileSync(p(new URL('site.webmanifest', PUBLIC)), JSON.stringify(manifest, null, 2) + '\n');
console.log('site.webmanifest written');

// The old PNG brand exports are superseded by the traced SVGs.
const stale = new URL('brand/', PUBLIC);
if (existsSync(p(stale))) { rmSync(p(stale), { recursive: true }); console.log('removed stale public/brand/'); }

// ---------------------------------------------------------------------------
// 5. Accessibility gate — parse the real tokens.css and assert WCAG AA.
// ---------------------------------------------------------------------------
const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const luminance = (hex) => {
  const h = hex.replace('#', '');
  return 0.2126 * srgb(parseInt(h.slice(0, 2), 16)) + 0.7152 * srgb(parseInt(h.slice(2, 4), 16)) + 0.0722 * srgb(parseInt(h.slice(4, 6), 16));
};
const contrast = (a, b) => {
  const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
  return (hi + 0.05) / (lo + 0.05);
};

/** Parse `--name: value;` declarations out of the first {...} block after `from`. */
function block(css, from) {
  const start = css.indexOf('{', css.indexOf(from));
  let depth = 0, end = start;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) { end = i; break; }
  }
  const out = {};
  for (const m of css.slice(start, end).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const tokensCss = readFileSync(p(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8');
const light = block(tokensCss, ':root {');
const darkMedia = block(tokensCss, '@media (prefers-color-scheme: dark)');
const darkPreview = block(tokensCss, ':root[data-theme="dark"]');

// consistency: the preview override must mirror the OS-driven dark theme
const MIRROR = ['color-primary', 'color-primary-hover', 'color-primary-active', 'color-on-primary', 'color-link', 'color-focus', 'color-bg', 'color-surface', 'brand-mark', 'brand-word'];
const drift = MIRROR.filter((k) => darkPreview[k] !== darkMedia[k]);
if (drift.length) {
  console.error(`\n✗ dark theme drift between @media and [data-theme="dark"]: ${drift.join(', ')}`);
  process.exitCode = 1;
}

// Every surface an accent can be painted on, and the required ratio.
const AA = 4.5;
const checks = [];
const check = (label, fg, bg, min = AA) => checks.push({ label, fg, bg, min, ratio: contrast(fg, bg) });

for (const [theme, t] of [['light', light], ['dark', darkMedia]]) {
  for (const surf of ['bg', 'surface', 'surface-2', 'neutral-soft']) {
    check(`${theme} --color-primary on --color-${surf}`, t['color-primary'], t[`color-${surf}`]);
    check(`${theme} --color-link on --color-${surf}`, t['color-link'], t[`color-${surf}`]);
  }
  check(`${theme} label on --color-primary`, t['color-on-primary'], t['color-primary']);
  check(`${theme} label on --color-primary-hover`, t['color-on-primary'], t['color-primary-hover']);
  check(`${theme} label on --color-primary-active`, t['color-on-primary'], t['color-primary-active']);
  if (theme === 'dark') check('--color-text-subtle on --color-surface', t['color-text-subtle'], t['color-surface']);
  // brand logo lockup on the surface it sits on (header = bg, footer = surface)
  check(`${theme} brand mark on --color-bg`, t['brand-mark'], t['color-bg']);
  check(`${theme} brand word on --color-surface`, t['brand-word'], t['color-surface']);
}

console.log('\nBrand / accent contrast audit (WCAG 2.2 AA):');
let failures = 0;
for (const c of checks) {
  const ok = c.ratio >= c.min;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${c.ratio.toFixed(2).padStart(6)}:1  (min ${c.min})  ${c.label}  [${c.fg} on ${c.bg}]`);
}

// the brand lockup must also hold where the site actually paints it
console.log(`\nBrand lockup: wordmark ${BRAND.red} / symbol ${BRAND.grey} / plate ${BRAND.charcoal}`);
console.log(`  full logo as drawn (red on charcoal): ${contrast(BRAND.red, BRAND.charcoal).toFixed(2)}:1 — illegible, which is why the icon uses the symbol only`);
console.log(`  symbol on plate: ${contrast(BRAND.grey, BRAND.charcoal).toFixed(2)}:1`);

if (failures || drift.length) {
  console.error(`\n✗ brand gate failed (${failures} contrast failure${failures === 1 ? '' : 's'})`);
  process.exitCode = 1;
} else {
  console.log('\n✓ brand assets generated, all contrast checks pass');
}
