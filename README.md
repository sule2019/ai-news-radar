# AI News Radar

Every AI story that mattered, ranked daily — a Product Hunt-style scannable feed for AI news.

Built with [Astro](https://astro.build): every page is pre-rendered static HTML (good for SEO), with a small amount of JavaScript for expanding stories and scroll-synced navigation.

## Commands

```sh
npm install       # once
npm run dev       # local dev server at http://localhost:4321
npm run build     # static build into dist/
npm run preview   # serve the built site locally
```

## How content works

All content lives in JSON files — no code changes needed to publish a day:

- `src/data/days/YYYY-MM-DD.json` — one file per day. The homepage shows all days newest-first, and each day also gets its own page at `/YYYY/MM/DD/`.
- `src/data/months/YYYY-MM.json` — "Best of" digest for a past month, served at `/best/YYYY/MM/`.

Day file shape:

```json
{
  "date": "2026-07-21",
  "stories": [
    {
      "cat": "models",            // models | research | funding | policy | products
      "signal": 94,               // 0-100 importance score (drives the pill color + bars)
      "sources": 41,              // number of outlets covering it
      "h": "Headline, punchy",
      "s": "One-line why-it-matters.",
      "b": ["Detail bullet 1", "Detail bullet 2", "Detail bullet 3"],
      "l": ["openai.com", "theverge.com", "+38"]   // source chips
    }
  ]
}
```

Stories should be pre-sorted by `signal` descending. Relative labels ("Today", "Yesterday", "2 days ago") are computed at build time from the current date, so the site should be rebuilt daily — which is also when new content lands.

## SEO structure

- `/` — full infinite feed (all days + monthly digests). As you scroll, the address bar updates to the day you're reading via `history.replaceState`, so copying the URL always gives a real, shareable page.
- `/2026/07/21/` — static page per day (canonical, OG tags, JSON-LD ItemList).
- `/2026/07/21/<story-slug>/` — **detail page per story** (clicking a story in any list opens this). Headline, lede, "what happened" bullets, outbound coverage links, prev/next story pager, JSON-LD Article. Slugs are generated from headlines at build time. Stories support an optional `"body": ["paragraph", ...]` field in the JSON for a fuller write-up — the pipeline should fill this.
- `/best/2026/06/` — static page per monthly digest, with story pages at `/best/2026/06/<story-slug>/`.
- Sitemap generated at `/sitemap-index.xml` (via `@astrojs/sitemap`), `robots.txt` in `public/`.

Before deploying: set the real domain in `astro.config.mjs` (`site:`) and `public/robots.txt`.

## The hourly pipeline

[pipeline/update.mjs](pipeline/update.mjs) runs every hour (via [.github/workflows/update.yml](.github/workflows/update.yml)):

1. Fetches all feeds in [pipeline/sources.json](pipeline/sources.json) (17 verified AI feeds: lab blogs, press AI sections, aggregators, arXiv)
2. Deduplicates and **clusters** items covering the same story (title-token similarity)
3. Scores each cluster's **signal** from coverage breadth × source weight
4. Keeps clusters covered by 2+ outlets (or a single weight-3 primary source)
5. Matches clusters against stories already published today — existing copy stays stable, only signal/source counts update
6. New clusters get their headline / why-it-matters / bullets / category written by GPT-5 nano (OpenAI structured outputs). Without an API key it falls back to draft copy from feed text.
7. Writes `src/data/days/<today>.json` (max 15 stories/day, sorted by signal) and commits. At midnight UTC the day freezes automatically — a new file starts.

Test locally with `node pipeline/update.mjs --dry-run` (prints instead of writing).

## Going live — one-time checklist

1. **Push to GitHub**: create a repo, `git add -A && git commit -m "initial" && git push`. The hourly workflow activates automatically.
2. **Add the API key**: repo → Settings → Secrets and variables → Actions → new secret `OPENAI_API_KEY` (from platform.openai.com). Without it the pipeline still runs but produces draft-quality copy.
3. **Connect Cloudflare Pages** (or Netlify): create a Pages project from the GitHub repo, build command `npm run build`, output directory `dist`. Every pipeline commit then auto-deploys the site.
4. Set the real domain in [astro.config.mjs](astro.config.mjs) (`site:`) and [public/robots.txt](public/robots.txt).
5. Delete the sample data files in `src/data/days/` and `src/data/months/` once real data has accumulated.

## Still to build

- **Monthly "Best of" generation** — a small script that picks the top 10 of a finished month into `src/data/months/`.
- **Newsletter** — the subscribe form is a front-end placeholder; wire it to a provider (Buttondown, Beehiiv, ConvertKit).
- **Per-story article links** — source chips currently link to outlet homepages; the pipeline stores enough data to link exact articles (story `srcTitles`/links) in a future iteration.
