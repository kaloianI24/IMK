const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (hex) => { const h = hex.replace('#', ''); return 0.2126 * srgb(parseInt(h.slice(0, 2), 16)) + 0.7152 * srgb(parseInt(h.slice(2, 4), 16)) + 0.0722 * srgb(parseInt(h.slice(4, 6), 16)); };
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
const dBg = '#121012', dSurf = '#1F1B1E', dSurf2 = '#2A2428';
console.log('cand     on#121012 on#1F1B1E on#2A2428 dnText#171315 white#FFFCF7');
for (const c of ['#E4677E', '#FF6B6B', '#FA7070', '#F07A7A', '#F58A8A', '#FF8080', '#EF7D7D', '#E87070', '#F57373', '#FF8F8F']) {
  console.log(`${c}   ${ratio(c, dBg).toFixed(2)}      ${ratio(c, dSurf).toFixed(2)}      ${ratio(c, dSurf2).toFixed(2)}      ${ratio('#171315', c).toFixed(2)}          ${ratio('#FFFCF7', c).toFixed(2)}`);
}
