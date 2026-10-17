// Temp: derive dark-mode tints of brand red #720606 and check button pairs.
const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (hex) => { const h = hex.replace('#', ''); return 0.2126 * srgb(parseInt(h.slice(0, 2), 16)) + 0.7152 * srgb(parseInt(h.slice(2, 4), 16)) + 0.0722 * srgb(parseInt(h.slice(4, 6), 16)); };
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
const hex = (n) => n.toString(16).padStart(2, '0');
const mixWhite = (h, t) => {
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  return `#${hex(Math.round(r + (255 - r) * t))}${hex(Math.round(g + (255 - g) * t))}${hex(Math.round(b + (255 - b) * t))}`;
};

const dBg = '#121012', dSurf = '#1F1B1E', dSurf2 = '#2A2428';
console.log('tint   on#121012  on#1F1B1E  on#2A2428   #171315-on-tint(button)');
for (const t of [0.55, 0.6, 0.62, 0.65, 0.68, 0.7, 0.75, 0.8]) {
  const c = mixWhite('#720606', t);
  console.log(`${c}  ${ratio(c, dBg).toFixed(2)}      ${ratio(c, dSurf).toFixed(2)}       ${ratio(c, dSurf2).toFixed(2)}        ${ratio('#171315', c).toFixed(2)}`);
}
console.log('\nExisting dark primary #E4677E as button with #171315:', ratio('#171315', '#E4677E').toFixed(2));
console.log('With white text #FFFCF7 on #E4677E:', ratio('#FFFCF7', '#E4677E').toFixed(2));

console.log('\n--- dark hover/active (lighter/darker of chosen) ---');
for (const c of ['#F0B4B4', '#EFA9A9', '#E49A9A']) console.log(c, ratio(c, dSurf).toFixed(2), ratio('#171315', c).toFixed(2));
console.log('\n--- light hover/active (darker brand red) ---');
for (const c of ['#5E0505', '#4B0404', '#8A1010']) console.log(c, 'on bg', ratio(c, '#F7F1E8').toFixed(2), '| on surface', ratio(c, '#FFFCF7').toFixed(2), '| white on it', ratio('#FFFCF7', c).toFixed(2));
console.log('\n--- link distinctness on light (link vs body text) ---');
console.log('#720606 vs #171315:', ratio('#720606', '#171315').toFixed(2), '(needs a non-colour cue: underline)');
