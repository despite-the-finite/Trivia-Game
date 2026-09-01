#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

/**
 * build-standalone — folds the whole game into one HTML file.
 *
 * `public/` needs no build to be served; this exists for the case where there is
 * nothing to serve it. The output has no external requests at all — stylesheet,
 * modules and question bank are inlined — so it plays from a file:// URL, a
 * USB stick, a static host or anywhere a single file can be opened.
 *
 * Two shapes come out of it, because two places want different things:
 *   dist/trivia.html          a complete document, for opening or hosting
 *   dist/trivia.fragment.html the same page without the document wrapper, for
 *                             hosts that supply their own <head> and <body>
 *
 *   npm run build:standalone
 */

async function bundleScript() {
  const result = await build({
    entryPoints: [resolve(root, 'public/js/app.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: false,
    write: false,
    legalComments: 'none',
  });
  return result.outputFiles[0].text;
}

/**
 * The page normally fetches the bank; inlining it is what removes the last
 * network request. LocalBackend's loader checks this global first, so nothing
 * about the runtime changes — it simply never reaches the fetch.
 */
function bankScript() {
  const bank = read('public/data/question-bank.json').trim();
  // Guard against a literal </script> inside the data ending the block early.
  return `window.__TRIVIA_BANK__ = ${bank.replace(/<\//g, '<\\/')};`;
}

function buildDocument() {
  const html = read('public/index.html');
  const css = read('public/styles.css');

  const head = html.slice(html.indexOf('<head>') + '<head>'.length, html.indexOf('</head>'));
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));

  const title = /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? 'Live Trivia';
  const icon = /<link\s+rel="icon"[^>]*>/s.exec(head)?.[0] ?? '';
  const description =
    'Trivia on world geography and settled science, playable in the browser with nothing to install.';

  const content = body
    // The module tag is replaced by the bundle; the bank goes in ahead of it.
    .replace(/\s*<script type="module"[^>]*><\/script>/, '');

  return { title, icon, description, css, content };
}

async function main() {
  const { title, icon, description, css, content } = buildDocument();
  const script = await bundleScript();

  const styleTag = `<style>\n${css}</style>`;
  const scriptTags = `<script>${bankScript()}</script>\n<script>\n${script}</script>`;
  const descriptionTag = `<meta name="description" content="${description}" />`;

  /**
   * The fragment form: no document wrapper, because the host that renders it
   * supplies its own. Everything it needs — title, styles, markup, behaviour —
   * still travels with it.
   */
  const fragment = [
    `<title>${title}</title>`,
    descriptionTag,
    styleTag,
    content.trim(),
    scriptTags,
  ].join('\n');

  const document = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    '    <meta name="theme-color" content="#12101c" />',
    '    <meta name="color-scheme" content="dark light" />',
    `    <title>${title}</title>`,
    `    ${descriptionTag}`,
    `    ${icon}`,
    `    ${styleTag}`,
    '  </head>',
    '  <body>',
    content.trim(),
    scriptTags,
    '  </body>',
    '</html>',
    '',
  ].join('\n');

  mkdirSync(resolve(root, 'dist'), { recursive: true });
  writeFileSync(resolve(root, 'dist/trivia.html'), document);
  writeFileSync(resolve(root, 'dist/trivia.fragment.html'), fragment);

  const kb = (value) => `${(Buffer.byteLength(value) / 1024).toFixed(0)} KB`;
  console.log('Wrote dist/trivia.html and dist/trivia.fragment.html');
  console.log(`  total ${kb(document)} \u2014 script ${kb(script)}, bank ${kb(bankScript())}, styles ${kb(css)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
