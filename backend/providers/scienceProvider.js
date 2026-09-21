import { fetchText, parseFeed, settleAll } from '../lib/fetchUtil.js';
import { sha256 } from '../lib/ids.js';

/**
 * scienceProvider — factual source material about science and research news.
 *
 * Same contract as newsProvider: fetch, filter, hand structured facts onward.
 * Science news moves more slowly than general news, so the acceptable age
 * window is much wider (see FRESHNESS.science in config.js).
 *
 * Variety is enforced here rather than hoped for. Every document is tagged
 * with a topic (space, physics, chemistry, biology, earth, health, tech), and
 * the final batch is assembled round-robin across topics with a hard ceiling
 * on space — NASA/ESA alone publish far more than every other feed combined,
 * so any order-based cut-off lets them crowd everything else out.
 */

/**
 * `topic` is set on feeds that are themselves about one subject; leave it off
 * for general feeds and each item is classified from its own text instead.
 */
const DEFAULT_FEEDS = [
  { sourceName: 'NASA', url: 'https://www.nasa.gov/news-release/feed/', topic: 'space' },
  { sourceName: 'ESA', url: 'https://www.esa.int/rssfeed/Our_Activities/Space_Science', topic: 'space' },
  { sourceName: 'Phys.org Biology', url: 'https://phys.org/rss-feed/biology-news/', topic: 'biology' },
  { sourceName: 'Phys.org Earth', url: 'https://phys.org/rss-feed/earth-news/', topic: 'earth' },
  { sourceName: 'Phys.org Chemistry', url: 'https://phys.org/rss-feed/chemistry-news/', topic: 'chemistry' },
  { sourceName: 'Phys.org Physics', url: 'https://phys.org/rss-feed/physics-news/', topic: 'physics' },
  { sourceName: 'Phys.org Technology', url: 'https://phys.org/rss-feed/technology-news/', topic: 'tech' },
  { sourceName: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/top/science.xml' },
  { sourceName: 'ScienceDaily Plants & Animals', url: 'https://www.sciencedaily.com/rss/plants_animals.xml', topic: 'biology' },
  { sourceName: 'ScienceDaily Health', url: 'https://www.sciencedaily.com/rss/health_medicine.xml', topic: 'health' },
  { sourceName: 'ScienceDaily Earth & Climate', url: 'https://www.sciencedaily.com/rss/earth_climate.xml', topic: 'earth' },
  { sourceName: 'ScienceDaily Matter & Energy', url: 'https://www.sciencedaily.com/rss/matter_energy.xml' },
  { sourceName: 'Nature', url: 'https://www.nature.com/nature.rss' },
  { sourceName: 'Nature Biology', url: 'https://www.nature.com/subjects/biological-sciences.rss', topic: 'biology' },
  { sourceName: 'MIT News Biology', url: 'https://news.mit.edu/rss/topic/biology', topic: 'biology' },
  { sourceName: 'MIT News Chemistry', url: 'https://news.mit.edu/rss/topic/chemistry', topic: 'chemistry' },
  { sourceName: 'MIT News Physics', url: 'https://news.mit.edu/rss/topic/physics', topic: 'physics' },
  { sourceName: 'USGS', url: 'https://www.usgs.gov/news/all/feed', topic: 'earth' },
  { sourceName: 'Science News', url: 'https://www.sciencenews.org/feed' },
  { sourceName: 'Live Science', url: 'https://www.livescience.com/feeds/all' },
  { sourceName: 'Ars Technica Science', url: 'https://feeds.arstechnica.com/arstechnica/science' },
  { sourceName: 'Smithsonian Magazine', url: 'https://www.smithsonianmag.com/rss/science-nature/' },
  { sourceName: 'Scientific American', url: 'https://www.scientificamerican.com/platform/syndication/rss/' },
];

const TOPICS = ['space', 'physics', 'chemistry', 'biology', 'earth', 'health', 'tech'];

/** Most of a batch that may be about space. Everything else shares the rest. */
export const MAX_SPACE_SHARE = 0.15;

function configuredFeeds() {
  const raw = process.env.SCIENCE_FEEDS;
  if (!raw) return DEFAULT_FEEDS;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sourceName, url, topic] = entry.split('|');
      return {
        sourceName: (sourceName || 'Science').trim(),
        url: (url || sourceName).trim(),
        topic: TOPICS.includes(topic?.trim()) ? topic.trim() : undefined,
      };
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

// Ordered: the first topic whose pattern matches wins. Space is checked first
// because a "black hole physics" story is still a space story for balancing.
const TOPIC_PATTERNS = [
  [
    'space',
    /\b(nasa|esa|spacex|astronaut|space station|spacecraft|rocket|satellite|telescope|james webb|hubble|galax(?:y|ies)|black holes?|exoplanets?|planets?|planetary|asteroids?|comets?|meteor(?:s|ite|ites)?|mars|lunar|moon|jupiter|saturn|venus|solar system|solar flare|solar wind|cosmic|cosmos|universe|supernova|nebula|big bang|dark matter|stars?|milky way|orbit(?:s|al|er)?)\b/i,
  ],
  [
    'health',
    /\b(patients?|clinical|disease|cancer|vaccines?|virus(?:es)?|bacteria|infection|drug|therapy|medical|medicine|brain|dementia|alzheimer|diabetes|heart|obesity|immune|antibod(?:y|ies)|surgery|health)\b/i,
  ],
  [
    'biology',
    /\b(species|animals?|plants?|fish|birds?|insects?|mammals?|dinosaurs?|fossils?|evolution|dna|genes?|genetic|genome|cells?|proteins?|ecosystem|forest|coral|bees?|whales?|primates?|fungi|microbes?|wildlife|extinct(?:ion)?)\b/i,
  ],
  [
    'earth',
    /\b(earthquakes?|volcan(?:o|oes|ic)|climate|glaciers?|ice sheets?|ocean|sea level|hurricanes?|storms?|weather|atmosphere|geolog(?:y|ical)|tectonic|drought|wildfires?|rivers?|erosion|carbon dioxide|emissions|permafrost|coast)\b/i,
  ],
  [
    'chemistry',
    /\b(chemical|chemistry|molecules?|molecular|catalysts?|polymers?|compounds?|elements?|reactions?|batter(?:y|ies)|crystals?|acids?|solvents?|synthesis|materials?)\b/i,
  ],
  [
    'physics',
    /\b(physics|physicists?|quantum|particles?|photons?|electrons?|neutrons?|atoms?|lasers?|superconduct\w*|magnet\w*|gravity|relativity|higgs|cern|collider|fusion|plasma|energy)\b/i,
  ],
  [
    'tech',
    /\b(robots?|robotics|ai|artificial intelligence|computers?|computing|software|chips?|semiconductors?|engineers?|engineering|drones?|3d[- ]print\w*|sensors?|internet|algorithms?)\b/i,
  ],
];

/** Topic for a feed item: the feed's own topic if it has one, else keyword-classified. */
export function classifyTopic(item, feedTopic) {
  if (feedTopic) return feedTopic;
  const text = `${item.title} ${item.summary ?? ''}`;
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(item.title) || pattern.test(text)) return topic;
  }
  return 'other';
}

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

/**
 * Picks up to `limit` documents, spread as evenly as possible across topics.
 *
 * Topics take turns, newest item first within each, so no subject can dominate
 * however prolific its feeds are. Space is held to MAX_SPACE_SHARE of the
 * batch; a single source is also capped so one prolific publisher cannot fill
 * a topic on its own. If the other topics run dry the batch is simply
 * shorter — fewer, more varied questions beat topping up with more space news.
 *
 * @param {Array<{topic: string, sourceName: string, publishedAt: Date}>} candidates
 */
export function selectBalanced(candidates, { limit, sourceCap }) {
  const buckets = new Map();
  for (const candidate of [...candidates].sort((a, b) => b.publishedAt - a.publishedAt)) {
    if (!buckets.has(candidate.topic)) buckets.set(candidate.topic, []);
    buckets.get(candidate.topic).push(candidate);
  }

  const spaceCap = Math.max(1, Math.floor(limit * MAX_SPACE_SHARE));
  const perSource = new Map();
  const perTopic = new Map();
  const selected = [];

  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const [topic, queue] of buckets) {
      if (selected.length >= limit) break;
      if (topic === 'space' && (perTopic.get(topic) ?? 0) >= spaceCap) continue;

      // Skip past items whose source is already at its cap.
      while (queue.length && (perSource.get(queue[0].sourceName) ?? 0) >= sourceCap) queue.shift();
      const next = queue.shift();
      if (!next) continue;

      perSource.set(next.sourceName, (perSource.get(next.sourceName) ?? 0) + 1);
      perTopic.set(topic, (perTopic.get(topic) ?? 0) + 1);
      selected.push(next);
      progressed = true;
    }
  }

  return selected;
}

export async function collect({ maxAgeMs = 45 * 24 * 60 * 60 * 1000, limit = 60 } = {}) {
  const feeds = configuredFeeds();
  const batches = await settleAll(
    feeds.map((feed) => async () => {
      const xml = await fetchText(feed.url, { accept: 'application/rss+xml, application/xml, text/xml' });
      return parseFeed(xml, { sourceName: feed.sourceName }).map((item) => ({
        ...item,
        topic: classifyTopic(item, feed.topic),
      }));
    }),
    { concurrency: 6, label: 'scienceProvider' },
  );

  const seenUrls = new Set();
  const candidates = [];
  for (const item of batches.flat()) {
    if (!isUsable(item, { maxAgeMs })) continue;
    const canonicalUrl = item.url.split('#')[0].split('?')[0];
    if (seenUrls.has(canonicalUrl)) continue;
    seenUrls.add(canonicalUrl);
    candidates.push({ ...item, url: canonicalUrl });
  }

  const sourceCap = Math.max(Math.ceil((limit / feeds.length) * 1.5), 3);
  const selected = selectBalanced(candidates, { limit, sourceCap });

  return selected.map((item) => ({
    provider: 'scienceProvider',
    category: 'science',
    title: item.title,
    url: item.url,
    sourceName: item.sourceName,
    publishedAt: item.publishedAt,
    facts: {
      headline: item.title,
      summary: item.summary,
      reportedBy: item.sourceName,
      reportedOn: item.publishedAt.toISOString(),
      topic: item.topic,
    },
    checksum: sha256(`scienceProvider|${item.url}|${item.title}`),
  }));
}

export default { collect, name: 'scienceProvider' };
