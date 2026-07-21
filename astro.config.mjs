import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// TODO: change to your real domain before deploying
export default defineConfig({
  site: 'https://signal.example.com',
  trailingSlash: 'always',
  integrations: [sitemap()],
});
