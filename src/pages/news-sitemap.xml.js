// Google News sitemap: stories from the last 48 hours only, per the spec.
// Rebuilt hourly with the site, so it always reflects the freshest stories.
import { getDays } from '../lib/data.js';

export async function GET(context) {
  const site = (context.site ?? new URL('https://ai-news-radar-ayi.pages.dev')).href.replace(/\/$/, '');
  const cutoff = Date.now() - 48 * 3600 * 1000;

  const entries = [];
  for (const day of getDays().slice(0, 3)) {
    for (const story of day.stories) {
      const published = story.ts ? Date.parse(story.ts) : Date.parse(`${day.date}T12:00:00Z`);
      if (!Number.isFinite(published) || published < cutoff) continue;
      entries.push({
        url: `${site}${story.url}`,
        date: new Date(published).toISOString(),
        title: story.h,
      });
    }
  }

  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${esc(e.url)}</loc>
    <news:news>
      <news:publication>
        <news:name>AI News Radar</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${e.date}</news:publication_date>
      <news:title>${esc(e.title)}</news:title>
    </news:news>
  </url>`
  )
  .join('\n')}
</urlset>
`;

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
