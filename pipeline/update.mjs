/**
 * AI News pipeline — runs hourly.
 *
 * fetch feeds → cluster duplicate coverage → score signal → write/summarize
 * today's JSON → (site rebuilds on push).
 *
 * Usage:
 *   node pipeline/update.mjs            # updates src/data/days/<today>.json
 *   node pipeline/update.mjs --dry-run  # prints the result, writes nothing
 *
 * Copywriting uses the OpenAI API (OPENAI_API_KEY in the environment).
 * Without credentials, stories get draft copy built from feed text
 * instead of LLM-written copy.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import OpenAI from 'openai';

const MODEL = 'gpt-5-nano'; // the one dial for writing quality vs cost

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const MAX_STORIES_PER_DAY = 15;
const MAX_ITEM_AGE_HOURS = 36;

/* ---------------- helpers ---------------- */

const STOPWORDS = new Set(
  'a an the of for to in on at with and or as is are be its it this that new says will after amid over from by how why what more less first best big'.split(' ')
);

function tokens(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/ - [^-]+$/, '') // "headline - Publisher" (Google News)
      .replace(/[^a-z0-9$€£% ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  );
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node['#text'] != null) return String(node['#text']);
  return '';
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/* ---------------- fetch & parse feeds ---------------- */

const AI_KEYWORDS =
  /\b(ai|a\.i\.|artificial intelligence|llm|openai|anthropic|deepmind|gemini|claude|gpt|chatgpt|copilot|machine learning|neural|robot|agent|chatbot|nvidia|inference|model|hugging face|mistral|xai|grok|perplexity|midjourney|stable diffusion|deepseek|qwen|llama)\b/i;

async function fetchFeed(source) {
  const res = await fetch(source.feed, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; AINewsBot/0.1)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);

  const rawItems = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
  const list = Array.isArray(rawItems) ? rawItems : [rawItems];
  const items = [];

  for (const it of list) {
    const title = stripHtml(text(it.title));
    if (!title) continue;

    let link = '';
    if (typeof it.link === 'string') link = it.link;
    else if (Array.isArray(it.link)) link = it.link.find((l) => l['@_rel'] !== 'self')?.['@_href'] ?? '';
    else if (it.link?.['@_href']) link = it.link['@_href'];
    link = String(link).trim();

    const dateStr = text(it.pubDate) || text(it.published) || text(it.updated) || text(it['dc:date']);
    const published = dateStr ? Date.parse(dateStr) : NaN;
    const ageHours = (Date.now() - published) / 3600000;
    if (Number.isFinite(published) && ageHours > MAX_ITEM_AGE_HOURS) continue;

    // General-tech feeds: keep only AI stories
    if (source.name === 'Techmeme' && !AI_KEYWORDS.test(title)) continue;

    // Google News items: real outlet lives in <source url="...">
    let domain = domainOf(link);
    if (it.source?.['@_url']) domain = domainOf(it.source['@_url']) ?? domain;

    // Full description/content — many feeds ship the entire article text here.
    const snippet = stripHtml(
      text(it['content:encoded']) || text(it.description) || text(it.summary) || text(it.content)
    ).slice(0, 2000);

    items.push({
      title: title.replace(/ - [^-]+$/, '').trim(),
      link,
      domain: domain ?? source.name.toLowerCase(),
      weight: source.weight,
      snippet,
      published: Number.isFinite(published) ? published : Date.now(),
    });
  }
  return items;
}

/* ---------------- cluster & score ---------------- */

function clusterItems(items) {
  const clusters = [];
  const sorted = [...items].sort((a, b) => b.weight - a.weight);
  for (const item of sorted) {
    const t = tokens(item.title);
    if (t.size < 2) continue;
    let best = null;
    let bestSim = 0;
    for (const c of clusters) {
      const sim = similarity(t, c.tokens);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= 0.5) {
      best.items.push(item);
      for (const tok of t) best.tokens.add(tok);
    } else {
      clusters.push({ items: [item], tokens: new Set(t) });
    }
  }
  for (const c of clusters) {
    const domains = new Map();
    for (const it of c.items) {
      if (!domains.has(it.domain) || domains.get(it.domain) < it.weight) domains.set(it.domain, it.weight);
    }
    c.domains = [...domains.keys()];
    c.rawWeight = [...domains.values()].reduce((a, b) => a + b, 0);
    c.signal = Math.max(15, Math.min(98, Math.round(34 * Math.log10(1 + 4.5 * c.rawWeight))));
    c.lead = c.items[0];
  }
  return clusters.sort((a, b) => b.signal - a.signal);
}

function keepCluster(c) {
  return c.domains.length >= 2 || c.rawWeight >= 3;
}

function sourceChips(c) {
  // One chip per outlet, linking to that outlet's actual article
  const seen = new Map();
  for (const it of c.items) {
    if (!seen.has(it.domain)) seen.set(it.domain, it.link || null);
  }
  const chips = [...seen.entries()].slice(0, 4).map(([d, u]) => (u ? { d, u } : { d }));
  const extra = seen.size - Math.min(seen.size, 4);
  if (extra > 0) chips.push({ d: `+${extra}` });
  return chips;
}

/* ---------------- LLM copywriting ---------------- */

const STORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stories'],
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'cat', 'h', 's', 'b', 'body'],
        properties: {
          id: { type: 'integer' },
          cat: { type: 'string', enum: ['models', 'research', 'funding', 'policy', 'products'] },
          h: { type: 'string' },
          s: { type: 'string' },
          b: { type: 'array', items: { type: 'string' } },
          body: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

async function writeCopy(entries) {
  // entries: [{ cluster, existingHeadline? }] — existingHeadline set when
  // enriching an already-published story (URL-stable, so h must not change).
  const client = new OpenAI();
  const input = entries.map(({ cluster, existingHeadline }, i) => ({
    id: i,
    ...(existingHeadline ? { existingHeadline } : {}),
    coverage: cluster.items
      .slice(0, 10)
      .map((it) => ({ outlet: it.domain, title: it.title, content: it.snippet })),
  }));

  const systemPrompt = [
      'You write for "AI News Radar", a ranked daily digest of AI news. For each story cluster you receive (headlines and article content from multiple outlets covering the same story), write:',
      '- h: one punchy, factual headline in plain language (no clickbait, no trailing period, sentence case). If the input has "existingHeadline", return it verbatim as h — the story is already published at a URL derived from it.',
      '- s: one sentence on why it matters to someone following AI — the "so what", not a restatement of the headline',
      '- b: 2-4 short factual bullets — the key details a scanner needs',
      '- body: the full article for the story page, as an array of paragraphs. Be as detailed as the coverage allows: include every concrete fact available — numbers, names, dates, prices, model names, direct quotes (attributed to the outlet that reported them, e.g. \'according to TechCrunch\'). Typically 3-6 paragraphs; more if the coverage is rich, fewer if it is thin. Structure: what happened, the specifics, context and reactions from the coverage, what happens next if reported.',
      '- cat: one of models (model releases/benchmarks), research (papers/studies), funding (raises/valuations/M&A/business), policy (regulation/government/safety policy), products (apps/tools/hardware/deployments)',
      '',
      'GROUNDING RULES (critical): Every claim in s, b, and body must come from the provided coverage. Never add facts, numbers, quotes, names, or background from your own knowledge — if a detail is not in the coverage, omit it rather than fill the gap. If outlets report conflicting details, state the conflict and attribute each version. Do not speculate or editorialize beyond what the coverage supports.',
      'Return one entry per input id.',
    ].join('\n');

  const response = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 32000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'stories', strict: true, schema: STORY_SCHEMA },
    },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(input) },
    ],
  });

  return JSON.parse(response.choices[0].message.content).stories;
}

function draftCopy(c, i) {
  return {
    id: i,
    cat: guessCategory(c),
    h: c.lead.title,
    s: (c.lead.snippet || `Covered by ${c.domains.length} outlet${c.domains.length > 1 ? 's' : ''}.`).slice(0, 200),
    b: c.items.slice(0, 3).map((it) => `${it.domain}: ${it.title}`),
    body: c.items
      .filter((it) => it.snippet)
      .slice(0, 4)
      .map((it) => `${it.domain}: ${it.snippet}`),
  };
}

function guessCategory(c) {
  const t = c.items.map((i) => i.title).join(' ').toLowerCase();
  if (/(raises|funding|valuation|acquires|acquisition|ipo|invest|billion|million)/.test(t)) return 'funding';
  if (/(regulat|law|act\b|senate|congress|policy|government|ban|court|lawsuit)/.test(t)) return 'policy';
  if (/(paper|study|research|benchmark|arxiv)/.test(t)) return 'research';
  if (/(launches|app|tool|feature|device|robot|update|release[sd]? )/.test(t)) return 'products';
  return 'models';
}

/* ---------------- main ---------------- */

async function main() {
  const { sources } = JSON.parse(readFileSync(join(ROOT, 'pipeline', 'sources.json'), 'utf8'));

  console.log(`Fetching ${sources.length} feeds…`);
  const results = await Promise.allSettled(sources.map(fetchFeed));
  const items = [];
  const seenLinks = new Set();
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`  ✗ ${sources[i].name}: ${r.reason.message}`);
      return;
    }
    console.log(`  ✓ ${sources[i].name}: ${r.value.length} items`);
    for (const item of r.value) {
      if (item.link && seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);
      items.push(item);
    }
  });

  const clusters = clusterItems(items).filter(keepCluster);
  console.log(`\n${items.length} items → ${clusters.length} story clusters after filtering`);

  const date = todayISO();
  const dayPath = join(ROOT, 'src', 'data', 'days', `${date}.json`);
  const existing = existsSync(dayPath)
    ? JSON.parse(readFileSync(dayPath, 'utf8'))
    : { date, stories: [] };

  // Match clusters to stories already published today. Signal/source counts
  // always update; the written copy is re-generated only when coverage grew
  // meaningfully (3+ new outlets) — and the headline never changes, because
  // the story's URL is derived from it.
  const usedClusters = new Set();
  const rewrites = [];
  for (const story of existing.stories) {
    const storyTokens = tokens((story.srcTitles ?? [story.h]).join(' '));
    let best = null;
    let bestSim = 0;
    clusters.forEach((c, ci) => {
      if (usedClusters.has(ci)) return;
      const sim = similarity(tokens(c.lead.title), storyTokens);
      if (sim > bestSim) {
        bestSim = sim;
        best = ci;
      }
    });
    if (best != null && bestSim >= 0.5) {
      usedClusters.add(best);
      const c = clusters[best];
      story.signal = Math.max(story.signal, c.signal);
      story.sources = Math.max(story.sources, c.domains.length);
      story.l = sourceChips(c);
      story.srcTitles = c.items.slice(0, 4).map((it) => it.title);
      // Re-write copy when coverage grew meaningfully, or when the story
      // only has draft copy (written while the LLM was unavailable)
      if (story.draft || c.domains.length >= (story.writtenSources ?? story.sources) + 3) {
        rewrites.push({ story, cluster: c });
      }
    }
  }

  // New clusters → new stories (respect the per-day cap)
  const room = MAX_STORIES_PER_DAY - existing.stories.length;
  const fresh = clusters
    .map((c, ci) => ({ c, ci }))
    .filter(({ ci }) => !usedClusters.has(ci))
    .slice(0, Math.max(0, room));

  if (fresh.length > 0 || rewrites.length > 0) {
    console.log(`${fresh.length} new stories, ${rewrites.length} to enrich with grown coverage`);
    const entries = [
      ...fresh.map(({ c }) => ({ cluster: c })),
      ...rewrites.map(({ story, cluster }) => ({ cluster, existingHeadline: story.h })),
    ];
    let copies = null;
    try {
      copies = await writeCopy(entries);
      console.log('Copy written by Claude');
    } catch (err) {
      console.warn(`LLM unavailable (${err.message}) — using draft copy from feed text`);
    }
    fresh.forEach(({ c }, i) => {
      const copy = copies?.find((x) => x.id === i) ?? draftCopy(c, i);
      const earliest = Math.min(Date.now(), ...c.items.map((it) => it.published));
      existing.stories.push({
        cat: copy.cat,
        signal: c.signal,
        sources: c.domains.length,
        ts: new Date(earliest).toISOString(),
        writtenSources: c.domains.length,
        ...(copies ? {} : { draft: true }),
        h: copy.h,
        s: copy.s,
        b: copy.b,
        body: copy.body,
        l: sourceChips(c),
        srcTitles: c.items.slice(0, 4).map((it) => it.title),
      });
    });
    rewrites.forEach(({ story, cluster }, ri) => {
      const copy = copies?.find((x) => x.id === fresh.length + ri);
      if (!copy) return; // no LLM available — keep the existing copy
      story.cat = copy.cat;
      story.s = copy.s;
      story.b = copy.b;
      story.body = copy.body;
      story.writtenSources = cluster.domains.length;
      delete story.draft;
    });
  } else {
    console.log('No new stories this run');
  }

  existing.stories.sort((a, b) => b.signal - a.signal);

  const out = JSON.stringify(existing, null, 2) + '\n';
  if (DRY_RUN) {
    console.log(`\n--- DRY RUN: would write ${dayPath} ---\n`);
    console.log(out);
  } else {
    writeFileSync(dayPath, out);
    console.log(`Wrote ${dayPath} (${existing.stories.length} stories)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
