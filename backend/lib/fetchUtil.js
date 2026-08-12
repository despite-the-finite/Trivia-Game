import { APP } from './config.js';

/** fetch with a hard timeout, a polite UA, and non-2xx treated as an error. */
export async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? APP.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': APP.userAgent,
        Accept: options.accept ?? '*/*',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      throw new Error(`GET ${url} -> HTTP ${res.status}`);
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(url, options) {
  const res = await fetchWithTimeout(url, options);
  return res.text();
}

export async function fetchJson(url, options) {
  const res = await fetchWithTimeout(url, { accept: 'application/json', ...options });
  return res.json();
}

/** Runs tasks with bounded concurrency, collecting successes and swallowing failures. */
export async function settleAll(tasks, { concurrency = 4, label = 'task' } = {}) {
  const results = [];
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      try {
        results.push(await task());
      } catch (err) {
        console.warn(`[${label}] failed: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…',
};

export function decodeEntities(input = '') {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

export function stripHtml(input = '') {
  return decodeEntities(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, tag) {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = block.match(cdata) || block.match(plain);
  return match ? decodeEntities(match[1]).trim() : null;
}

/**
 * Minimal RSS 2.0 / Atom reader. Feeds are a deliberate choice here: they are
 * stable, publisher-controlled, and carry the title, canonical link, summary and
 * publication date we need for provenance without an API key.
 */
export function parseFeed(xml, { sourceName }) {
  const items = [];
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  for (const block of blocks) {
    const title = tagValue(block, 'title');
    let link = tagValue(block, 'link');
    if (!link) {
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = href ? decodeEntities(href[1]) : null;
    }
    const summaryRaw =
      tagValue(block, 'description') ||
      tagValue(block, 'summary') ||
      tagValue(block, 'content:encoded') ||
      tagValue(block, 'content') ||
      '';
    const dateRaw =
      tagValue(block, 'pubDate') ||
      tagValue(block, 'published') ||
      tagValue(block, 'updated') ||
      tagValue(block, 'dc:date');

    if (!title || !link) continue;
    const publishedAt = dateRaw ? new Date(dateRaw) : null;

    items.push({
      title: stripHtml(title),
      url: link.trim(),
      summary: stripHtml(summaryRaw).slice(0, 1500),
      publishedAt: publishedAt && !Number.isNaN(publishedAt.valueOf()) ? publishedAt : null,
      sourceName,
    });
  }
  return items;
}
