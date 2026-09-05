/**
 * Reads `.env` into process.env for the command-line scripts.
 *
 * Vercel injects environment variables itself, so this is only for local runs
 * and for the one production task you run from your own machine (`npm run
 * migrate` against the hosted database). Values already present in the real
 * environment always win, so `DATABASE_URL=… npm run migrate` overrides the file.
 *
 * Deliberately tiny and dependency-free: it handles `KEY=value`, `export KEY=…`,
 * comments, blank lines and surrounding quotes, which is all `.env.example` uses.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parseDotEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    let value = raw;
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing `# comment` only from an unquoted value.
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

/** @returns {Promise<boolean>} whether a .env file was found and applied. */
export async function loadDotEnv(path = join(root, '.env')) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}
