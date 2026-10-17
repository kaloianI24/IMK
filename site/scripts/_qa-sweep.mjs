// QA sweep: heading outline, content artifacts, logo presence per route.
import fs from 'node:fs';
import path from 'node:path';

const dist = 'C:/Users/Kalch/Documents/IXI/site/dist';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.html') ? [path.join(d, e.name)] : []));

let allOk = true;
for (const f of walk(dist)) {
  const html = fs.readFileSync(f, 'utf8');
  const route = f.slice(dist.length).replace(/\\/g, '/').replace(/index\.html$/, '') || '/';
  const hs = [...html.matchAll(/<h([1-6])\b/g)].map((m) => +m[1]);
  const skips = [];
  for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) skips.push(`${hs[i - 1]}->${hs[i]}`);
  const h1s = hs.filter((h) => h === 1).length;
  const art = /<\|end\|>|<\|start\|>|rfl:parameter/.test(html);
  const yaml = /order: [234]/.test(html) && route.startsWith('/services/');
  const hasLogo = html.includes('var(--brand-mark)') && html.includes('var(--brand-word)');
  const fail = skips.length > 0 || art || yaml || h1s > 1;
  if (fail) allOk = false;
  console.log(
    (fail ? 'FAIL' : 'ok  ').padEnd(5),
    route.padEnd(40),
    `outline=${hs.join(',')} h1s=${h1s} logo=${hasLogo ? 'Y' : 'n'}` +
    (art ? ' ARTIFACT' : '') + (yaml ? ' YAMLTEXT' : '') + (skips.length ? ` SKIPS:${skips.join(',')}` : ''),
  );
}
console.log(allOk ? 'ALL PAGES CLEAN' : 'DEFECTS REMAIN');
