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
const MAX_ITEM_AGE_HOURS = 36;

/* ---------------- helpers ---------------- */

const STOPWORDS = new Set(
  'a an the of for to in on at with and or as is are be its it this that new says say will after amid over from by how why what more less first best big'.split(' ')
);

// Crude plural stemming so "sanctions" matches "sanction", "models" matches "model"
function stem(w) {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

function tokens(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/ - [^-]+$/, '') // "headline - Publisher" (Google News)
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9.$€£% ]+/g, ' ') // keep dots so "3.6" survives as a token
      .split(/\s+/)
      .map((w) => stem(w.replace(/^\.+|\.+$/g, '')))
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
    item.titleTokens = t;
    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      // Title-to-title comparison only — never against an accumulated token
      // union, which grows into a trap that swallows unrelated items
      for (const ci of c.items.slice(0, 5)) {
        const p = titlePair(t, ci.titleTokens);
        if (p.match && p.score > bestScore) {
          bestScore = p.score;
          best = c;
        }
      }
    }
    if (best) {
      best.items.push(item);
    } else {
      clusters.push({ items: [item] });
    }
  }

  // Second pass: merge clusters that are the same story worded differently
  // ("US weighs sanctions…" vs "US threatens sanctions…"). Compares item
  // titles pairwise, so one cluster's accumulated tokens can't mask a match.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusterMatch(clusters[i], clusters[j])) {
          clusters[i].items.push(...clusters[j].items);
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  for (const c of clusters) {
    const domains = new Map();
    for (const it of c.items) {
      if (!domains.has(it.domain) || domains.get(it.domain) < it.weight) domains.set(it.domain, it.weight);
    }
    c.domains = [...domains.keys()];
    c.rawWeight = [...domains.values()].reduce((a, b) => a + b, 0);
    // Signal = who it's about (primary) + coverage (secondary) + freshness.
    // Base: tier-1 entity (frontier labs / big tech / major governments) 42,
    // tier-2 30, unknown 20 — a major-player story with 2 sources outranks an
    // unknown with 4. Coverage: log curve over effective sources; weight-1
    // long-tail outlets count as √n so syndication can't inflate a story.
    // Freshness: small boost that decays as the story ages within the day.
    const strong = [...domains.values()].filter((w) => w >= 2);
    const weak = c.domains.length - strong.length;
    const effN = strong.length + Math.sqrt(weak);
    const tier = entityTier(c);
    const base = tier === 1 ? 42 : tier === 2 ? 30 : 20;
    const coverage = 40 * Math.log10(Math.max(1, effN)) + 2 * strong.reduce((a, w) => a + (w - 1), 0);
    const ageH = (Date.now() - Math.min(...c.items.map((it) => it.published))) / 3600000;
    const freshness = ageH < 2 ? 6 : ageH < 5 ? 3 : 0;
    c.signal = Math.max(15, Math.min(98, Math.round(base + coverage + freshness)));
    c.lead = c.items[0];
  }
  return clusters.sort((a, b) => b.signal - a.signal);
}

// Two titles describe the same story if they share ≥50% of the shorter
// title's meaningful words AND at least ~4 words absolutely — the floor
// stops generic-word chains ("chinese"+"ai"+"model") from merging
// different stories.
function titlePair(a, b) {
  if (!a?.size || !b?.size) return { score: 0, match: false };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const min = Math.min(a.size, b.size);
  const score = inter / min;
  const match = score >= 0.5 && inter >= Math.min(4, min - 1);
  return { score, match };
}

function clusterMatch(a, b) {
  for (const ia of a.items.slice(0, 4)) {
    for (const ib of b.items.slice(0, 4)) {
      if (titlePair(ia.titleTokens, ib.titleTokens).match) return true;
    }
  }
  return false;
}

// Best matching similarity between a cluster and a published story (0 = no match)
function storySim(cluster, story) {
  const titles = [story.h, ...(story.srcTitles ?? [])].map(tokens);
  let best = 0;
  for (const it of cluster.items.slice(0, 4)) {
    for (const t of titles) {
      const p = titlePair(it.titleTokens, t);
      if (p.match) best = Math.max(best, p.score);
    }
  }
  return best;
}

function keepCluster(c) {
  return c.domains.length >= 2 || c.rawWeight >= 3;
}

/* ---------------- entity weighting ---------------- */

// Who the story is about matters more than how many outlets covered it.
// Tier 1: frontier labs, big tech, majors — their news moves the field.
const TIER1 = [
  'openai', 'chatgpt', 'gpt', 'sora', 'anthropic', 'claude', 'google', 'deepmind', 'gemini',
  'meta', 'llama', 'microsoft', 'copilot', 'nvidia', 'apple', 'siri', 'amazon', 'aws',
  'alexa', 'xai', 'grok', 'tesla', 'mistral', 'deepseek', 'alibaba', 'qwen', 'baidu',
  'bytedance', 'tiktok', 'moonshot', 'kimi', 'samsung', 'intel', 'amd', 'oracle', 'ibm',
  'white house', 'congress', 'senate', 'eu ai act', 'european union', 'brussels',
];
// Tier 2: notable AI companies and institutions — significant but not field-moving.
const TIER2 = [
  'cursor', 'perplexity', 'hugging face', 'cohere', 'stability ai', 'midjourney', 'runway',
  'databricks', 'scale ai', 'salesforce', 'adobe', 'palantir', 'spacex', 'stanford', 'mit',
  'harvard', 'oxford', 'fda', 'sec', 'doj', 'pentagon', 'united nations', 'california',
];

// Word-boundary matching — 'intel' must not match "intelligence"
const tierRegex = (list) =>
  new RegExp(`\\b(${list.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
const TIER1_RE = tierRegex(TIER1);
const TIER2_RE = tierRegex(TIER2);

function entityTier(c) {
  const text = c.items
    .slice(0, 6)
    .map((it) => it.title.toLowerCase())
    .join(' ');
  if (TIER1_RE.test(text)) return 1;
  if (TIER2_RE.test(text)) return 2;
  return 0;
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

/* ---------------- article fetching ---------------- */

// Aggregator pages whose links aren't the underlying article
const NO_FETCH = new Set(['techmeme.com', 'reddit.com', 'www.reddit.com']);

async function fetchArticleText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; AINewsBot/0.1)', accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const finalUrl = res.url || url;
  const html = await res.text();
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const paras = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((t) => t.length > 60);
  return { text: paras.join('\n').slice(0, 5000), finalUrl };
}

// Pull real article text for the top items of each cluster being written,
// so the model works from full reporting instead of one-line feed snippets.
// Google News links redirect to the real outlet — capture the final URL.
async function enrichWithArticles(entries) {
  const targets = [];
  for (const { cluster } of entries) {
    for (const it of cluster.items.slice(0, 3)) {
      if (it.link && !NO_FETCH.has(it.domain) && !it.fullText) targets.push(it);
    }
  }
  const results = await Promise.allSettled(targets.map((it) => fetchArticleText(it.link)));
  let ok = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value.text) return;
    const it = targets[i];
    it.fullText = r.value.text;
    const finalDomain = domainOf(r.value.finalUrl);
    if (finalDomain && finalDomain !== 'news.google.com') {
      it.link = r.value.finalUrl;
      it.domain = finalDomain;
    }
    ok++;
  });
  console.log(`Fetched full text for ${ok}/${targets.length} articles`);
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
      .slice(0, 8)
      .map((it) => ({ outlet: it.domain, title: it.title, content: it.fullText || it.snippet })),
  }));

  const systemPrompt = [
      'You are the news writer for "AI News Radar", a ranked daily digest of AI news. Each input is one story, with coverage from one or more outlets (outlet domain, headline, article text). For each story write:',
      '- h: one punchy, factual headline in plain language (no clickbait, no trailing period, sentence case). If the input has "existingHeadline", return it verbatim as h — the story is already published at a URL derived from it.',
      '- s: one sentence on why this story matters to someone following AI. It must add stakes or consequences beyond the headline — never restate the headline, never re-list product names, never use abstract filler like "shows how X shapes Y". Concrete beats abstract.',
      '- b: 2-4 scannable fact bullets — the hardest specifics in the coverage: numbers, names, dates, prices, capabilities.',
      '- body: the full story as news prose, an array of paragraphs. Be as detailed as the coverage allows — every concrete fact, figure, and quote, structured as: what happened, the specifics, context and reactions, what happens next if reported. Typically 3-6 paragraphs; fewer only if the coverage is genuinely thin. Do not repeat the bullet sentences verbatim — bullets are the scan layer, the body is the full account.',
      '- cat: one of models (model releases/benchmarks), research (papers/studies), funding (raises/valuations/M&A/business), policy (regulation/government/safety policy), products (apps/tools/hardware/deployments)',
      '',
      'VOICE (critical): Write as a news reporter stating facts directly — not as someone summarizing articles. NEVER use meta-language: "the piece", "the article", "the coverage", "notes that", "highlights", "discusses", "is described as", "is noted for". Wrong: "The Verge\'s coverage notes the display is improved." Right: "The new display is significantly improved, The Verge reported." Weave attribution in naturally for specific claims and all quotes ("..., according to Reuters"). techmeme.com is an aggregator, not a source — the real outlet is named inside its headline text (e.g. "(Emma Roth/The Verge)"); attribute to that outlet, never to Techmeme. If a name or term appears in the coverage without explanation, use it exactly as the coverage does or omit it — do not guess what it means.',
      '',
      'GROUNDING RULES (critical): Every claim in s, b, and body must come from the provided coverage. Never add facts, numbers, quotes, names, or background from your own knowledge — if a detail is not in the coverage, omit it rather than fill the gap. If outlets report conflicting details, state the conflict and attribute each version. Do not speculate or editorialize beyond what the coverage supports.',
      '',
      'Before returning, re-read each story against its coverage and fix any claim the coverage does not directly support — especially who did what to whom, and which country or company an action applies to.',
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
  const matched = new Set();
  const rewrites = [];
  // Stories iterate highest-signal first (file is kept sorted), so when two
  // published stories are really the same story, the stronger one claims the
  // cluster and the weaker is removed as a duplicate below.
  for (const story of existing.stories) {
    let best = null;
    let bestSim = 0;
    clusters.forEach((c, ci) => {
      if (usedClusters.has(ci)) return;
      const sim = storySim(c, story);
      if (sim > bestSim) {
        bestSim = sim;
        best = ci;
      }
    });
    if (best != null && bestSim > 0) {
      usedClusters.add(best);
      matched.add(story);
      const c = clusters[best];
      // Signal always reflects the latest measured coverage (not a stale max)
      story.signal = c.signal;
      story.sources = c.domains.length;
      if (!story.ts) story.ts = new Date().toISOString(); // fallback: scan time
      story.l = sourceChips(c);
      story.srcTitles = c.items.slice(0, 4).map((it) => it.title);
      // Re-write copy when coverage grew meaningfully, or when the story
      // only has draft copy (written while the LLM was unavailable)
      if (story.draft || c.domains.length >= (story.writtenSources ?? story.sources) + 3) {
        rewrites.push({ story, cluster: c });
      }
    } else {
      // Coverage faded from the feeds: the story cools instead of freezing
      // at its last score, so stale stories sink through the day.
      story.signal = Math.max(15, story.signal - 4);
      if (!story.ts) story.ts = new Date().toISOString();
    }
  }

  // Remove duplicate published stories: an unmatched story that still
  // resembles an already-claimed cluster is the same story under different
  // wording (published before the matcher improved, or from a split cluster).
  const dupes = [];
  existing.stories = existing.stories.filter((story) => {
    if (matched.has(story)) return true;
    for (const ci of usedClusters) {
      if (storySim(clusters[ci], story) > 0) {
        dupes.push(story.h);
        return false;
      }
    }
    return true;
  });
  if (dupes.length > 0) console.log(`Removed ${dupes.length} duplicate stories:\n  ${dupes.join('\n  ')}`);

  // New clusters → new stories (no cap: the quality gate in keepCluster
  // does the curation; the day's length reflects the news cycle)
  const fresh = clusters
    .map((c, ci) => ({ c, ci }))
    .filter(({ ci }) => !usedClusters.has(ci));

  if (fresh.length > 0 || rewrites.length > 0) {
    console.log(`${fresh.length} new stories, ${rewrites.length} to enrich with grown coverage`);
    const entries = [
      ...fresh.map(({ c }) => ({ cluster: c })),
      ...rewrites.map(({ story, cluster }) => ({ cluster, existingHeadline: story.h })),
    ];
    await enrichWithArticles(entries);
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
      story.l = sourceChips(cluster); // refreshed post-enrichment (resolved article URLs)
      story.writtenSources = cluster.domains.length;
      delete story.draft;
    });
  } else {
    console.log('No new stories this run');
  }

  // Rank: signal, then breadth of coverage, then freshness
  existing.stories.sort(
    (a, b) =>
      b.signal - a.signal ||
      b.sources - a.sources ||
      (Date.parse(b.ts ?? 0) || 0) - (Date.parse(a.ts ?? 0) || 0)
  );

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
