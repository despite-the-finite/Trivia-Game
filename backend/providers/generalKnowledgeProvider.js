import { fetchJson } from '../lib/fetchUtil.js';
import { sha256 } from '../lib/ids.js';

/**
 * generalKnowledgeProvider — factual source material for evergreen trivia
 * (history, notable people, culture), sourced from Wikipedia's "On This Day"
 * API rather than an LLM's own recall.
 *
 * Same contract as newsProvider/scienceProvider: fetch, filter, hand structured
 * facts onward. Unlike the news/science feeds this content isn't really "aging"
 * — it changes because we ask about a different calendar day each refresh, which
 * happens to line up naturally with the once-a-day refresh cadence.
 */

const ENDPOINT_TYPES = ['events', 'births', 'deaths'];

function todayMonthDay() {
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return { month, day };
}

function isUsableEntry(entry) {
  if (typeof entry.text !== 'string' || entry.text.length < 20) return false;
  if (!Number.isFinite(entry.year)) return false;
  const page = (entry.pages || []).find(
    (p) => typeof p.extract === 'string' && p.extract.length > 60 && p.content_urls?.desktop?.page,
  );
  return Boolean(page);
}

function bestPage(entry) {
  return entry.pages.find(
    (p) => typeof p.extract === 'string' && p.extract.length > 60 && p.content_urls?.desktop?.page,
  );
}

/**
 * @returns {Promise<Array<{provider,category,title,url,sourceName,publishedAt,facts,checksum}>>}
 */
export async function collect({ limit = 30 } = {}) {
  const { month, day } = todayMonthDay();

  const batches = await Promise.all(
    ENDPOINT_TYPES.map(async (type) => {
      try {
        const data = await fetchJson(
          `https://en.wikipedia.org/api/rest_v1/feed/onthisday/${type}/${month}/${day}`,
        );
        return (Array.isArray(data?.[type]) ? data[type] : []).map((entry) => ({ ...entry, type }));
      } catch (err) {
        console.warn(`[generalKnowledgeProvider] ${type} feed failed: ${err.message}`);
        return [];
      }
    }),
  );

  const seenUrls = new Set();
  const documents = [];

  for (const entry of batches.flat()) {
    if (!isUsableEntry(entry)) continue;
    const page = bestPage(entry);
    const canonicalUrl = page.content_urls.desktop.page;
    if (seenUrls.has(canonicalUrl)) continue;
    seenUrls.add(canonicalUrl);

    const headline =
      entry.type === 'events'
        ? `${entry.year}: ${entry.text}`
        : `${entry.text} (${entry.type === 'births' ? 'born' : 'died'} ${entry.year})`;

    documents.push({
      provider: 'generalKnowledgeProvider',
      category: 'general-knowledge',
      title: headline,
      url: canonicalUrl,
      sourceName: 'Wikipedia',
      publishedAt: null,
      facts: {
        headline,
        summary: `${entry.text} ${page.extract}`.trim(),
        year: entry.year,
        pageTitle: page.title,
      },
      checksum: sha256(`generalKnowledgeProvider|${canonicalUrl}|${headline}`),
    });

    if (documents.length >= limit) break;
  }

  return documents;
}

export default { collect, name: 'generalKnowledgeProvider' };
