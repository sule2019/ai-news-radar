import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Update `site` when a custom domain is attached
export default defineConfig({
  site: 'https://ai-news-radar-ayi.pages.dev',
  trailingSlash: 'always',
  integrations: [sitemap()],
});
