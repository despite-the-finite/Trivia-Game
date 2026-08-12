import { fetchText, parseFeed, settleAll } from '../lib/fetchUtil.js';
import { sha256 } from '../lib/ids.js';

/**
 * scienceProvider — factual source material about science and research news.
 *
 * Same contract as newsProvider: fetch, filter, hand structured facts onward.
 * Science news moves more slowly than general news, so the acceptable age
 * window is much wider (see FRESHNESS.science in config.js).
 */

const DEFAULT_FEEDS = [
  { sourceName: 'NASA', url: 'https://www.nasa.gov/news-release/feed/' },
  { sourceName: 'ESA', url: 'https://www.esa.int/rssfeed/Our_Activities/Space_Science' },
  { sourceName: 'Phys.org', url: 'https://phys.org/rss-feed/' },
  { sourceName: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/top/science.xml' },
  { sourceName: 'Nature', url: 'https://www.nature.com/nature.rss' },
  { sourceName: 'NOAA', url: 'https://www.noaa.gov/media-release/feed' },
  { sourceName: 'NIH', url: 'https://www.nih.gov/news-events/news-releases/feed' },
  { sourceName: 'CERN', url: 'https://home.cern/api/news/news/feed.rss' },
];

function configuredFeeds() {
  const raw = process.env.SCIENCE_FEEDS;
  if (!raw) return DEFAULT_FEEDS;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sourceName, url] = entry.split('|');
      return { sourceName: (sourceName || 'Science').trim(), url: (url || sourceName).trim() };
    });
}

const EXCLUDED_TITLE_PATTERNS = [
  /\bopinion\b/i,
  /\beditorial\b/i,
  /\bcomment\b/i,
  /\bbook review\b/i,
  /\bobituary\b/i,
  /\bcareer column\b/i,
  /\bpodcast\b/i,
  /\bcorrespondence\b/i,
];

const SPECULATIVE_PATTERNS = [
  /\b(could|might|may|hints? at|suggests? that|raises? questions)\b/i,
];

function isUsable(item, { maxAgeMs }) {
  if (!item.title || item.title.length < 20) return false;
  if (!item.summary || item.summary.length < 80) return false;
  if (!/^https?:\/\//.test(item.url)) return false;
  if (EXCLUDED_TITLE_PATTERNS.some((re) => re.test(item.title))) return false;
  if (SPECULATIVE_PATTERNS.some((re) => re.test(item.title))) return false;
  if (!item.publishedAt) return false;
  if (Date.now() - item.publishedAt.valueOf() > maxAgeMs) return false;
  return true;
}

export async function collect({ maxAgeMs = 45 * 24 * 60 * 60 * 1000, limit = 60 } = {}) {
  const feeds = configuredFeeds();
  const batches = await settleAll(
    feeds.map((feed) => async () => {
      const xml = await fetchText(feed.url, { accept: 'application/rss+xml, application/xml, text/xml' });
      return parseFeed(xml, { sourceName: feed.sourceName });
    }),
    { concurrency: 4, label: 'scienceProvider' },
  );

  const seenUrls = new Set();
  const documents = [];

  for (const item of batches.flat()) {
    if (!isUsable(item, { maxAgeMs })) continue;
    const canonicalUrl = item.url.split('#')[0].split('?')[0];
    if (seenUrls.has(canonicalUrl)) continue;
    seenUrls.add(canonicalUrl);

    documents.push({
      provider: 'scienceProvider',
      category: 'science',
      title: item.title,
      url: canonicalUrl,
      sourceName: item.sourceName,
      publishedAt: item.publishedAt,
      facts: {
        headline: item.title,
        summary: item.summary,
        reportedBy: item.sourceName,
        reportedOn: item.publishedAt.toISOString(),
      },
      checksum: sha256(`scienceProvider|${canonicalUrl}|${item.title}`),
    });

    if (documents.length >= limit) break;
  }

  documents.sort((a, b) => b.publishedAt - a.publishedAt);
  return documents;
}

export default { collect, name: 'scienceProvider' };
