import crypto from 'node:crypto';

/** Ambiguous characters (0/O, 1/I/L) are excluded so codes survive being read aloud. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomFrom(alphabet, length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * Friend codes look like "KARSH-7F4X": a readable stem derived from the display
 * name plus random characters, so they are easy to say out loud but still hard
 * to guess.
 */
export function friendCode(displayName = '') {
  const stem = displayName
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 5);
  const prefix = stem.length >= 3 ? stem : randomFrom(CODE_ALPHABET, 5);
  return `${prefix}-${randomFrom(CODE_ALPHABET, 4)}`;
}

export function normalizeFriendCode(code) {
  if (typeof code !== 'string') return null;
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length < 6 || cleaned.length > 12) return null;
  // Canonical form always separates the last four characters.
  return `${cleaned.slice(0, -4)}-${cleaned.slice(-4)}`;
}

/** Short, URL-safe challenge id, e.g. "abc123xy". */
export function challengeSlug() {
  return randomFrom(SLUG_ALPHABET, 8);
}

export function recoveryCode() {
  return `${randomFrom(CODE_ALPHABET, 4)}-${randomFrom(CODE_ALPHABET, 4)}-${randomFrom(CODE_ALPHABET, 4)}`;
}

export function opaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Deterministic RNG (mulberry32) seeded from a string. Used for the daily
 * challenge so that a given day always produces the same question order for
 * every player, and for challenge answer permutations.
 */
export function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates using an injectable RNG so shuffles can be made reproducible. */
export function shuffle(items, rng = Math.random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
