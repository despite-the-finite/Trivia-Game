import { fetchJson, settleAll } from '../lib/fetchUtil.js';
import { sha256, seededRandom, shuffle } from '../lib/ids.js';
import { todayGameDay } from '../lib/day.js';

/**
 * entertainmentProvider — factual source material for mainstream media and
 * entertainment trivia: TV, film, video games, music and animation.
 *
 * Same contract as the other providers: fetch, filter, hand structured facts
 * onward. Material comes from Wikipedia page summaries, drawn from two pools:
 *
 *   * a curated list of well-known titles, franchises and artists, walked a
 *     window at a time by game day so consecutive days ask about different
 *     things. This keeps the category mainstream by construction.
 *   * what people are actually reading: Wikipedia's most-read articles from
 *     the previous game day, kept only when the article's short description
 *     says it is a show, film, game, song, performer and so on.
 *
 * Variety is enforced here, as in scienceProvider: every document carries a
 * topic and the batch is assembled round-robin across topics, so no single
 * medium (Hollywood films, say) can fill the quiz on its own.
 */

export const TOPICS = ['tv', 'film', 'games', 'music', 'animation', 'people'];

/**
 * Wikipedia page titles. Redirects are followed, and a title that no longer
 * resolves is simply skipped. Deliberately global and cross-generational: the
 * bar is "most people have heard of it", not "critically acclaimed".
 */
const CURATED = {
  tv: [
    'Friends', 'The Office (American TV series)', 'Breaking Bad', 'Game of Thrones', 'Stranger Things',
    'Squid Game', 'The Crown (TV series)', "Grey's Anatomy", 'Seinfeld', 'The Sopranos',
    'Succession (TV series)', 'Ted Lasso', 'The Mandalorian', 'Wednesday (TV series)',
    'The Last of Us (TV series)', 'Doctor Who', 'Downton Abbey', 'Money Heist',
    'How I Met Your Mother', 'The Big Bang Theory', 'Modern Family', 'Survivor (American TV series)',
    'American Idol', 'The Great British Bake Off', 'Saturday Night Live', 'Sesame Street', 'Bridgerton',
    'The Walking Dead (TV series)', 'Sherlock (TV series)', 'The Bear (TV series)', 'Parks and Recreation',
    'Brooklyn Nine-Nine', 'Jeopardy!', 'House of the Dragon', 'Severance (TV series)', 'The Boys (TV series)',
    'Only Murders in the Building', 'Emmy Awards', 'Netflix',
  ],
  film: [
    'Titanic (1997 film)', 'Jurassic Park (film)', 'Star Wars (film)', 'The Godfather', 'Back to the Future',
    'Avatar (2009 film)', 'The Dark Knight', 'Avengers: Endgame', 'Harry Potter (film series)',
    'The Lord of the Rings (film series)', 'Jaws (film)', 'E.T. the Extra-Terrestrial', 'Home Alone',
    'Forrest Gump', 'The Matrix', 'Barbie (film)', 'Oppenheimer (film)', 'Top Gun: Maverick',
    'Parasite (2019 film)', 'Black Panther (film)', 'Mission: Impossible (film series)',
    'James Bond in film', 'Indiana Jones', 'Mean Girls', 'The Wizard of Oz (1939 film)', 'Rocky',
    'Ghostbusters', 'Everything Everywhere All at Once', 'Dune (2021 film)', '3 Idiots', 'RRR (film)',
    'Crouching Tiger, Hidden Dragon', 'Fast & Furious', 'Pirates of the Caribbean (film series)',
    'Inception', 'Marvel Cinematic Universe', 'Academy Awards', 'Bollywood',
  ],
  games: [
    'Minecraft', 'Tetris', 'Super Mario Bros.', 'Mario Kart 8', 'Pokémon', 'The Legend of Zelda',
    'Fortnite', 'Grand Theft Auto V', 'Pac-Man', 'Sonic the Hedgehog', 'Call of Duty', 'The Sims',
    'Animal Crossing: New Horizons', 'Roblox', 'League of Legends', 'Among Us', 'Halo (franchise)',
    'Street Fighter II', 'Pong', 'Space Invaders', 'The Last of Us', 'Red Dead Redemption 2',
    'Elden Ring', 'World of Warcraft', 'Candy Crush Saga', 'Angry Birds', 'Wii Sports',
    'PlayStation 2', 'Nintendo Switch', 'Game Boy', 'Final Fantasy VII', 'Super Smash Bros.',
    'Pokémon Go', "Baldur's Gate 3", 'The Elder Scrolls V: Skyrim', 'Mortal Kombat', 'Resident Evil',
    'Donkey Kong', 'Xbox',
  ],
  music: [
    'The Beatles', 'Michael Jackson', 'Taylor Swift', 'Beyoncé', 'BTS', 'Madonna', 'Elvis Presley',
    'Queen (band)', 'ABBA', 'Adele', 'Eminem', 'Rihanna', 'Ed Sheeran', 'Bad Bunny', 'Billie Eilish',
    'Thriller (album)', 'Bohemian Rhapsody', 'Eurovision Song Contest', 'Grammy Awards',
    'Super Bowl halftime show', 'Coldplay', 'The Rolling Stones', 'Whitney Houston', 'Lady Gaga',
    'Bruno Mars', 'Shakira', 'Dolly Parton', 'Bob Marley', 'Nirvana (band)', 'Blackpink',
    'Stevie Wonder', 'Prince (musician)', 'Olivia Rodrigo', 'Harry Styles', 'Kendrick Lamar',
    'Dua Lipa', 'Hamilton (musical)', 'The Phantom of the Opera (1986 musical)', 'Spotify',
  ],
  animation: [
    'The Simpsons', 'SpongeBob SquarePants', 'Toy Story', 'Shrek', 'Spirited Away', 'Dragon Ball',
    'Naruto', 'One Piece', 'Attack on Titan', 'Studio Ghibli', 'Pixar', 'Mickey Mouse', 'Looney Tunes',
    'Scooby-Doo', 'Family Guy', 'South Park', 'Bluey (2018 TV series)', 'Avatar: The Last Airbender',
    'Finding Nemo', 'Up (2009 film)', 'Inside Out (2015 film)', 'Coco (2017 film)', 'Moana (2016 film)',
    'The Incredibles', 'Spider-Man: Into the Spider-Verse', 'Frozen (2013 film)', 'The Lion King',
    'Superman', 'Batman', 'Spider-Man', 'Wonder Woman', 'Peanuts', 'Garfield', 'Rick and Morty',
    'Demon Slayer: Kimetsu no Yaiba', 'Sailor Moon', 'Tom and Jerry', 'Bugs Bunny',
  ],
};

/** How many curated titles to try per refresh, beyond `limit`, to absorb misses. */
const CURATED_HEADROOM = 4;

/** Most of a batch that may come from trending articles. */
export const MAX_TRENDING_SHARE = 0.4;

// Ordered: the first topic whose pattern matches a page's short description
// wins. Animation is checked before film/tv so "American animated sitcom" or
// "2016 animated film" count as animation.
const TOPIC_PATTERNS = [
  ['animation', /\b(animated|animation|anime|manga|cartoon|comic(?:s| book)?|superhero)\b/i],
  ['games', /\b(video games?|game series|game franchise|gaming|esports|game console|handheld console|mobile game)\b/i],
  ['tv', /\b(television|tv series|sitcom|miniseries|soap opera|reality (?:show|series|competition)|talk show|game show|streaming (?:service|series)|web series)\b/i],
  ['film', /\b(film|films|movie|film series|media franchise)\b/i],
  ['music', /\b(singer|rapper|songwriter|musician|band|boy band|girl group|album|song|single|musical|record producer|dj|disc jockey|music festival|music video)\b/i],
  ['people', /\b(actor|actress|comedian|entertainer|television (?:host|presenter)|youtuber|streamer|internet personality|filmmaker|film director|voice actor)\b/i],
];

/**
 * Descriptions that make an otherwise entertainment-looking page a poor fit for
 * a light, mainstream quiz.
 */
const EXCLUDED_DESCRIPTIONS = [
  /\bpornograph/i,
  /\badult film\b/i,
  /\b(politician|murder(?:er|ed)?|serial killer|criminal|convicted|shooting|terrorist|war|massacre|disaster)\b/i,
  /\blist of\b/i,
  /\bdisambiguation\b/i,
];

/** Topic for a Wikipedia summary, from its short description; null if not entertainment. */
export function classifyTopic(description) {
  if (typeof description !== 'string' || !description.trim()) return null;
  if (EXCLUDED_DESCRIPTIONS.some((re) => re.test(description))) return null;
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(description)) return topic;
  }
  return null;
}

/** Days since the Unix epoch for a `YYYY-MM-DD` game day. */
function dayNumber(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** One fixed interleaving of the curated list, so each day's window spans every topic. */
const CURATED_ORDER = shuffle(
  Object.entries(CURATED).flatMap(([topic, titles]) => titles.map((title) => ({ topic, title }))),
  seededRandom('entertainment-curated-v1'),
);

/**
 * The curated titles for a game day: a contiguous window of CURATED_ORDER that
 * advances by `size` each day, wrapping around. Consecutive days never share a
 * title, and every title comes round once per full cycle.
 */
export function curatedWindow(day, size, order = CURATED_ORDER) {
  if (!order.length || size <= 0) return [];
  const n = Math.min(size, order.length);
  const start = (dayNumber(day) * n) % order.length;
  return Array.from({ length: n }, (_, i) => order[(start + i) % order.length]);
}

/**
 * Picks up to `limit` documents, topics taking turns, trending first within a
 * topic (it is what people are talking about) and capped at `trendingCap` so
 * the evergreen list always keeps a foothold.
 */
export function selectBalanced(candidates, { limit, trendingCap = limit }) {
  const buckets = new Map(TOPICS.map((t) => [t, []]));
  for (const c of candidates) {
    if (!buckets.has(c.topic)) continue;
    buckets.get(c.topic).push(c);
  }
  for (const queue of buckets.values()) queue.sort((a, b) => Number(b.trending) - Number(a.trending));

  const selected = [];
  let trending = 0;
  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const queue of buckets.values()) {
      if (selected.length >= limit) break;
      while (queue.length && queue[0].trending && trending >= trendingCap) queue.shift();
      const next = queue.shift();
      if (!next) continue;
      if (next.trending) trending += 1;
      selected.push(next);
      progressed = true;
    }
  }
  return selected;
}

const SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

function isUsableSummary(page) {
  if (!page || page.type === 'disambiguation') return false;
  if (typeof page.extract !== 'string' || page.extract.length < 120) return false;
  return Boolean(page.content_urls?.desktop?.page);
}

async function fetchSummary(title) {
  return fetchJson(`${SUMMARY_URL}${encodeURIComponent(title.replace(/ /g, '_'))}`);
}

/** The game day before `day`, as `YYYY/MM/DD` for the featured-content feed. */
function previousDayPath(day) {
  const [y, m, d] = day.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return prev.toISOString().slice(0, 10).replace(/-/g, '/');
}

async function collectTrending(day) {
  try {
    const data = await fetchJson(`https://en.wikipedia.org/api/rest_v1/feed/featured/${previousDayPath(day)}`);
    const articles = Array.isArray(data?.mostread?.articles) ? data.mostread.articles : [];
    return articles
      .filter(isUsableSummary)
      .map((page) => ({ page, topic: classifyTopic(page.description), trending: true }))
      .filter((c) => c.topic);
  } catch (err) {
    console.warn(`[entertainmentProvider] trending feed failed: ${err.message}`);
    return [];
  }
}

async function collectCurated(day, size) {
  const window = curatedWindow(day, size);
  const pages = await settleAll(
    window.map(({ title, topic }) => async () => ({ page: await fetchSummary(title), topic, trending: false })),
    { concurrency: 6, label: 'entertainmentProvider' },
  );
  return pages.filter((c) => isUsableSummary(c.page));
}

/**
 * @returns {Promise<Array<{provider,category,title,url,sourceName,publishedAt,facts,checksum}>>}
 */
export async function collect({ limit = 9 } = {}) {
  const day = todayGameDay();
  const [trending, curated] = await Promise.all([
    collectTrending(day),
    collectCurated(day, limit + CURATED_HEADROOM),
  ]);

  const seenUrls = new Set();
  const candidates = [];
  for (const c of [...trending, ...curated]) {
    const url = c.page.content_urls.desktop.page;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    candidates.push({ ...c, url });
  }

  const trendingCap = Math.max(1, Math.floor(limit * MAX_TRENDING_SHARE));
  const selected = selectBalanced(candidates, { limit, trendingCap });

  return selected.map(({ page, topic, url }) => {
    const headline = page.description ? `${page.title} (${page.description})` : page.title;
    return {
      provider: 'entertainmentProvider',
      category: 'entertainment',
      title: page.title,
      url,
      sourceName: 'Wikipedia',
      publishedAt: null,
      facts: {
        headline,
        summary: page.extract,
        topic,
      },
      checksum: sha256(`entertainmentProvider|${url}|${page.extract}`),
    };
  });
}

export default { collect, name: 'entertainmentProvider' };
