import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Trailing-slash policy: no trailing slash globally.
export default defineConfig({
  site: (process.env.SITE_URL || 'https://www.ixi.example').replace(/\/$/, ''),
  output: 'static',
  trailingSlash: 'never',
  integrations: [sitemap()],
  vite: {},
});