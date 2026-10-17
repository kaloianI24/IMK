// Lighthouse CI configuration.
//
// Plan §6: mobile, median of 5 runs, ≥90 on all four categories for Home, a
// service page and /book. `/pricing/` is included as well: it carried the
// heading-order defect, so we keep it under the gate.
//
// Color scheme. The site ships one theme per `prefers-color-scheme` and no
// toggle (plan D9). Headless Chrome follows the host OS preference, which makes
// scores machine-dependent — and the dark theme is exactly where the contrast
// regression was found. We therefore pin the scheme explicitly so CI always
// audits the same, reproducible theme. Blink flag mapping, verified against
// Chromium's `blink.mojom.PreferredColorScheme` (kDark=0, kLight=1):
//   --blink-settings=preferredColorScheme=0  -> dark   (default here)
//   --blink-settings=preferredColorScheme=1  -> light
// Run the other theme locally with:  LHCI_COLOR_SCHEME=light npm run lhci
const colorScheme = process.env.LHCI_COLOR_SCHEME === 'light' ? 1 : 0;

// Chrome discovery. CI (ubuntu-latest) has Chrome on PATH, which LHCI finds on
// its own; a Windows dev machine usually has Edge instead. Either can be
// overridden with CHROME_PATH.
const chromePath = process.env.CHROME_PATH
  ? process.env.CHROME_PATH
  : process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined;

module.exports = {
  ci: {
    collect: {
      numberOfRuns: 5,
      staticDistDir: './dist',
      settings: {
        ...(chromePath ? { chromePath } : {}),
        chromeFlags: `--headless=new --blink-settings=preferredColorScheme=${colorScheme}`,
        formFactor: 'mobile',
      },
      // NOTE: the option is `url` (singular, array-valued) in LHCI 0.14.
      // A `urls` key is silently ignored and LHCI falls back to auto-discovering
      // the first `maxAutodiscoverUrls` (5) HTML files under dist — which pulled
      // in /404.html and failed the SEO gate on the intentional noindex.
      url: ['/', '/services/', '/pricing/', '/book/'],
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.9 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        'categories:seo': ['error', { minScore: 0.9 }],
      },
    },
    // Write report evidence next to the repo (plan §6: qa/artifacts/lighthouse).
    // The `filesystem` target needs no git context and no network, so the gate
    // cannot be broken by an upload/telemetry failure. Stable filenames (no
    // timestamp) keep the evidence diff-free between runs.
    upload: {
      target: 'filesystem',
      outputDir: 'qa/artifacts/lighthouse',
      reportFilenamePattern: '%%PATHNAME%%.report.%%EXTENSION%%',
    },
  },
};
