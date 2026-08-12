import crypto from 'node:crypto';
import { queryOne, query } from '../db/index.js';
import { sha256 } from './ids.js';
import { unauthorized } from './http.js';

/**
 * Player identity is a bearer token generated server-side at account creation.
 * Only its SHA-256 is stored, so a database leak does not hand out sessions.
 */

export function extractToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim() || null;
  }
  return null;
}

export async function findPlayerByToken(token) {
  if (!token) return null;
  const player = await queryOne(
    `SELECT id, display_name, friend_code, email, is_anonymous, created_at
       FROM players
      WHERE token_hash = $1`,
    [sha256(token)],
  );
  return player;
}

/** Requires a valid token; throws 401 otherwise. */
export async function requirePlayer(req) {
  const player = await findPlayerByToken(extractToken(req));
  if (!player) throw unauthorized();
  // Best-effort liveness tracking; never block the request on it.
  query('UPDATE players SET last_seen_at = NOW() WHERE id = $1', [player.id]).catch(() => {});
  return player;
}

/** Returns the player when a valid token is present, otherwise null. */
export async function optionalPlayer(req) {
  return findPlayerByToken(extractToken(req));
}

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isAdminRequest(req) {
  const key = process.env.TRIVIA_ADMIN_KEY;
  if (!key) return false;
  const provided = req.headers?.['x-admin-key'];
  return typeof provided === 'string' && timingSafeEqual(provided, key);
}
