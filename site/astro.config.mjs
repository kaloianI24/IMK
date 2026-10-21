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
  vite: {},
});