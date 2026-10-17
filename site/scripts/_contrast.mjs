// Temp: evaluate WCAG contrast for brand-colour candidates.
const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (hex) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
};
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
const fmt = (a, b) => `${a} on ${b}: ${ratio(a, b).toFixed(2)}:1`;

console.log('--- LIGHT: brand red as primary ---');
const lightBg = '#F7F1E8', surface = '#FFFCF7', dark = '#171315';
for (const red of ['#720606', '#8A1010', '#7A0A0A']) {
  console.log(fmt(red, lightBg), '|', fmt(red, surface), '|', fmt('#FFFCF7', red));
}
console.log('on-primary #FFFCF7 vs #720606:', ratio('#FFFCF7', '#720606').toFixed(2));
console.log('--- existing light primary for reference ---');
console.log(fmt('#B01C3B', lightBg), '|', fmt('#FFFCF7', '#B01C3B'));

console.log('\n--- DARK: need >=4.5:1 on #121012 and #1F1B1E ---');
const dBg = '#121012', dSurf = '#1F1B1E', dSurf2 = '#2A2428';
for (const c of ['#E4677E', '#EA7C90', '#E98888', '#EFA0A0', '#F0A5A5', '#E9A3A3', '#F2B0B0', '#CCCCCC', '#E0A0A0', '#F5C0C0']) {
  console.log(c.padEnd(8), fmt(c, dBg), '|', fmt(c, dSurf), '|', fmt(c, dSurf2));
}
console.log('\n--- dark text ---');
console.log(fmt('#F6F1EA', dBg), '|', fmt('#B7AEA7', dBg), '|', fmt('#9E9590', dBg), '|', fmt('#9E9590', dSurf));

console.log('\n--- the brand colours on their own plates ---');
console.log('red #720606 on charcoal #222222:', ratio('#720606', '#222222').toFixed(2), '(the illegible FullLogo pair)');
console.log('grey #CCCCCC on charcoal #222222:', ratio('#CCCCCC', '#222222').toFixed(2));
console.log('red #720606 on white:', ratio('#720606', '#FFFFFF').toFixed(2));
console.log('grey #CCCCCC on white:', ratio('#CCCCCC', '#FFFFFF').toFixed(2));
