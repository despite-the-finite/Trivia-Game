#!/usr/bin/env node
/**
 * Local development server.
 *
 * Mounts the same `api/*.js` handlers Vercel would run, and serves `public/`
 * statically, so `npm run dev` behaves like the deployed app without needing
 * the Vercel CLI.
 *
 *   npm run dev          →  http://localhost:3000
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { loadDotEnv } from './load-env.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const publicDir = join(root, 'public');
const port = Number.parseInt(process.env.PORT ?? '3000', 10);

// Load .env if present, so `npm run dev` picks up local credentials.
if (await loadDotEnv(join(root, '.env'))) console.log('Loaded .env');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const handlerCache = new Map();

async function loadHandler(routePath) {
  if (handlerCache.has(routePath)) return handlerCache.get(routePath);
  const filePath = join(root, 'api', `${routePath}.js`);
  try {
    await stat(filePath);
  } catch {
    handlerCache.set(routePath, null);
    return null;
  }
  // Cache-bust on each load in dev so edits are picked up without a restart.
  const mod = await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
  const handler = mod.default;
  return handler;
}

async function serveStatic(req, res, urlPath) {
  let relative = decodeURIComponent(urlPath);
  if (relative.endsWith('/')) relative += 'index.html';

  // Client-side routes fall back to the SPA shell.
  const isAsset = Boolean(extname(relative));
  const target = normalize(join(publicDir, relative));
  if (!target.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    if (isAsset) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const shell = await readFile(join(publicDir, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }).end(shell);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    const routePath = url.pathname.slice('/api/'.length).replace(/\/$/, '');
    const handler = await loadHandler(routePath);
    if (!handler) {
      res
        .writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { code: 'not_found', message: `No API route /api/${routePath}` } }));
      return;
    }
    // Mirror the Vercel request surface the handlers expect.
    req.query = Object.fromEntries(url.searchParams.entries());
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[dev-server] handler threw', err);
      if (!res.headersSent) {
        res
          .writeHead(500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { code: 'internal_error', message: err.message } }));
      }
    }
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(port, () => {
  console.log(`\n  Live Trivia dev server → http://localhost:${port}\n`);
  if (!process.env.DATABASE_URL) {
    console.warn('  ⚠  DATABASE_URL is not set — API calls will fail until it is.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠  ANTHROPIC_API_KEY is not set — only geography questions can be generated.');
  }
  console.log('');
});
