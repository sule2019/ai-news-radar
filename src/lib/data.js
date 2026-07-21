const dayModules = import.meta.glob('../data/days/*.json', { eager: true });
const monthModules = import.meta.glob('../data/months/*.json', { eager: true });

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const CATS = {
  models: 'Models',
  research: 'Research',
  funding: 'Funding',
  policy: 'Policy',
  products: 'Products',
};

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysAgo(iso) {
  return Math.round((parseISO(todayISO()) - parseISO(iso)) / 86400000);
}

function relativeLabel(iso) {
  const diff = daysAgo(iso);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  const d = parseISO(iso);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function shortDate(iso) {
  const d = parseISO(iso);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]}, ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function longDate(iso) {
  const d = parseISO(iso);
  return `${WEEKDAYS_LONG[d.getUTCDay()]}, ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function plainDate(iso) {
  const d = parseISO(iso);
  return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function withStoryUrls(sectionUrl, stories) {
  const seen = new Map();
  return stories.map((st) => {
    let slug = slugify(st.h);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n + 1}`;
    return { ...st, slug, url: `${sectionUrl}${slug}/` };
  });
}

export function getDays() {
  return Object.values(dayModules)
    .map((m) => m.default ?? m)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((day) => {
      const [y, mo, d] = day.date.split('-');
      const diff = daysAgo(day.date);
      const url = `/${y}/${mo}/${d}/`;
      return {
        kind: 'day',
        id: `d-${day.date}`,
        date: day.date,
        url,
        navLabel: diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : `${MONTHS_SHORT[Number(mo) - 1]} ${Number(d)}`,
        title: relativeLabel(day.date),
        sub: shortDate(day.date),
        fullDate: longDate(day.date),
        stories: withStoryUrls(url, day.stories),
      };
    });
}

export function getMonths() {
  return Object.values(monthModules)
    .map((m) => m.default ?? m)
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((month) => {
      const [y, mo] = month.month.split('-');
      const name = MONTHS_LONG[Number(mo) - 1];
      const url = `/best/${y}/${mo}/`;
      return {
        kind: 'month',
        id: `m-${month.month}`,
        month: month.month,
        url,
        navLabel: name,
        title: `Best of ${name}`,
        sub: `Top ${month.stories.length} · ${name} ${y}`,
        stories: withStoryUrls(url, month.stories),
      };
    });
}

export function getSections() {
  return [...getDays(), ...getMonths()];
}

export function sigTier(n) {
  return n >= 70 ? 't-hot' : n >= 40 ? 't-warm' : 't-cool';
}

export function sigBarsOn(n) {
  return Math.max(1, Math.ceil(n / 25));
}
