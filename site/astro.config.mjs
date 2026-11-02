import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Trailing-slash policy: no trailing slash globally.
export default defineConfig({
  site: (process.env.SITE_URL || 'https://www.imk.example').replace(/\/$/, ''),
  output: 'static',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      filter: (pageUrl) => {
        const u = new URL(pageUrl);
        const p = u.pathname;
        return p !== '/login' && !p.startsWith('/login/') && p !== '/portal' && !p.startsWith('/portal/') && p !== '/admin' && !p.startsWith('/admin/');
      },
    }),
  ],
  vite: {
    build: {
      // The deployed CSP is `script-src 'self'` without 'unsafe-inline', so a
      // script the bundler inlines into the HTML is silently blocked by the
      // browser (this is what killed the mobile menu, the login forms and the
      // pricing form on the live site). Forcing every asset into its own file
      // keeps all script tags external and CSP-compatible.
      assetsInlineLimit: 0,
    },
  },
});