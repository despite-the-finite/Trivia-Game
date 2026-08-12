import { fetchText, parseFeed, settleAll } from '../lib/fetchUtil.js';
import { sha256 } from '../lib/ids.js';

/**
 * newsProvider — collects *factual source material* about recent events.
 *
 * This layer never invents anything and never talks to an LLM. Its only job is
 * to return {title, url, sourceName, publishedAt, facts} records that the
 * question generator is allowed to use as its sole ground truth.
 *
 * Feeds are wire-service and public-broadcaster general-news feeds, chosen for
 * factual reporting over commentary. Override with NEWS_FEEDS (comma-separated
 * `Name|url` pairs) to point at your own sources.
 */

const DEFAULT_FEEDS = [
  { sourceName: 'Reuters', url: 'https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best' },
  { sourceName: 'Associated Press', url: 'https://rsshub.app/apnews/topics/apf-topnews' },
  { sourceName: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { sourceName: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
  { sourceName: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { sourceName: 'CBC News', url: 'https://www.cbc.ca/webfeed/rss/rss-world' },
  { sourceName: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
];

function configuredFeeds() {
  const raw = process.env.NEWS_FEEDS;
  if (!raw) return DEFAULT_FEEDS;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sourceName, url] = entry.split('|');
      return { sourceName: (sourceName || 'News').trim(), url: (url || sourceName).trim() };
    });
}

/**
 * Headlines that are opinion, live blogs or rolling summaries make poor trivia:
 * they have no single objectively-correct answer, or they change under us.
 */
const EXCLUDED_TITLE_PATTERNS = [
  /\bopinion\b/i,
  /\beditorial\b/i,
  /\banalysis\b/i,
  /\bcommentary\b/i,
  /\blive updates?\b/i,
  /\blive blog\b/i,
  /\bwhat we know\b/i,
  /\bhere'?s what\b/i,
  /\bpodcast\b/i,
  /\bphotos? of the (day|week)\b/i,
  /\bin pictures\b/i,
  /\bquiz\b/i,
  /\byour (morning|evening) briefing\b/i,
];

/** Speculative language means the "fact" is not settled — skip it. */
const SPECULATIVE_PATTERNS = [
  /\b(could|might|may|would|rumou?r|reportedly|allegedly|is expected to|set to|poised to)\b/i,
];

function isUsable(item, { maxAgeMs }) {
  if (!item.title || item.title.length < 20) return false;
  if (!item.summary || item.summary.length < 60) return false;
  if (!/^https?:\/\//.test(item.url)) return false;
  if (EXCLUDED_TITLE_PATTERNS.some((re) => re.test(item.title))) return false;
  if (SPECULATIVE_PATTERNS.some((re) => re.test(item.title))) return false;
  if (!item.publishedAt) return false;
  if (Date.now() - item.publishedAt.valueOf() > maxAgeMs) return false;
  if (item.publishedAt.valueOf() > Date.now() + 6 * 60 * 60 * 1000) return false; // clock skew / bad feed
  return true;
}

/**
 * @returns {Promise<Array<{provider,category,title,url,sourceName,publishedAt,facts,checksum}>>}
 */
export async function collect({ maxAgeMs = 3 * 24 * 60 * 60 * 1000, limit = 60 } = {}) {
  const feeds = configuredFeeds();
  const batches = await settleAll(
    feeds.map((feed) => async () => {
      const xml = await fetchText(feed.url, { accept: 'application/rss+xml, application/xml, text/xml' });
      return parseFeed(xml, { sourceName: feed.sourceName });
    }),
    { concurrency: 4, label: 'newsProvider' },
  );

  const seenUrls = new Set();
  const seenTitles = new Set();
  const documents = [];

  for (const item of batches.flat()) {
    if (!isUsable(item, { maxAgeMs })) continue;

    const canonicalUrl = item.url.split('#')[0].split('?')[0];
    if (seenUrls.has(canonicalUrl)) continue;
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seenTitles.has(titleKey)) continue;
    seenUrls.add(canonicalUrl);
    seenTitles.add(titleKey);

    const facts = {
      headline: item.title,
      summary: item.summary,
      reportedBy: item.sourceName,
      reportedOn: item.publishedAt.toISOString(),
    };

    documents.push({
      provider: 'newsProvider',
      category: 'current-events',
      title: item.title,
      url: canonicalUrl,
      sourceName: item.sourceName,
      publishedAt: item.publishedAt,
      facts,
      checksum: sha256(`newsProvider|${canonicalUrl}|${item.title}`),
    });

    if (documents.length >= limit) break;
  }

  // Freshest first: current-events questions should lean on today's news.
  documents.sort((a, b) => b.publishedAt - a.publishedAt);
  return documents;
}

export default { collect, name: 'newsProvider' };
