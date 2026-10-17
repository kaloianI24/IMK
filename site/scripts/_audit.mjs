// Temp: full token-ramp contrast audit for the brand rebrand.
const srgb = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (hex) => { const h = hex.replace('#', ''); return 0.2126 * srgb(parseInt(h.slice(0, 2), 16)) + 0.7152 * srgb(parseInt(h.slice(2, 4), 16)) + 0.0722 * srgb(parseInt(h.slice(4, 6), 16)); };
const R = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };

const LIGHT = {
  surfaces: { bg: '#F7F1E8', surface: '#FFFCF7', surface2: '#FFFDF9', neutralSoft: '#E8E0D4' },
  ramp: { primary: '#720606', hover: '#5E0505', active: '#4B0404' },
  onPrimary: '#FFFCF7',
};
const DARK = {
  surfaces: { bg: '#121012', surface: '#1F1B1E', surface2: '#2A2428', neutralSoft: '#2F292D' },
  ramp: { primary: '#EF7D7D', hover: '#F79A9A', active: '#E46A6A' },
  onPrimary: '#171315',
};

function audit(name, t, linkIsHover = true) {
  console.log(`\n===== ${name} =====`);
  const heads = Object.keys(t.surfaces);
  console.log(`token            hex      lum     ${heads.map(h => h.padEnd(12)).join('')}`);
  for (const [k, v] of Object.entries(t.ramp)) {
    const row = heads.map(h => `${R(v, t.surfaces[h]).toFixed(2)}${R(v, t.surfaces[h]) >= 4.5 ? ' ✓' : ' ✗'}`.padEnd(12)).join('');
    console.log(`${k.padEnd(16)} ${v}  ${lum(v).toFixed(3)}  ${row}`);
  }
  const link = linkIsHover ? t.ramp.hover : t.ramp.primary;
  console.log(`link(=hover) ${link} -> ${heads.map(h => `${R(link, t.surfaces[h]).toFixed(2)}`).join(', ')}`);
  console.log('label on primary:', t.onPrimary, '=', R(t.onPrimary, t.ramp.primary).toFixed(2));
  console.log('label on hover  :', R(t.onPrimary, t.ramp.hover).toFixed(2));
  console.log('label on active :', R(t.onPrimary, t.ramp.active).toFixed(2));
  console.log('primary vs body text (light only meaningful):', R(t.ramp.primary, t.surfaces.surface).toFixed(2));
}

audit('LIGHT', LIGHT);
audit('DARK', DARK);

console.log('\n--- brand mark colours ---');
console.log('red #720606 on light bg:', R('#720606', '#F7F1E8').toFixed(2), '| on surface:', R('#720606', '#FFFCF7').toFixed(2));
console.log('grey #CCCCCC on dark bg:', R('#CCCCCC', '#121012').toFixed(2), '| on surface:', R('#CCCCCC', '#1F1B1E').toFixed(2), '| on charcoal:', R('#CCCCCC', '#222222').toFixed(2));
console.log('tint #EF7D7D on dark bg:', R('#EF7D7D', '#121012').toFixed(2), '| on surface:', R('#EF7D7D', '#1F1B1E').toFixed(2));
