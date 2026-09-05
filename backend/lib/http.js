import { APP } from './config.js';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Missing or invalid player token.') =>
  new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed.') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found.') => new ApiError(404, 'not_found', msg);
export const conflict = (msg, details) => new ApiError(409, 'conflict', msg, details);
export const tooManyRequests = (msg = 'Slow down a moment.') =>
  new ApiError(429, 'rate_limited', msg);
export const unavailable = (msg) => new ApiError(503, 'unavailable', msg);

/**
 * Which cross-origin caller, if any, this response may be shared with.
 *
 * The game and its API are same-origin, so the default allowlist is empty and
 * no CORS grant is issued at all. `ALLOWED_ORIGINS` opens it to named origins;
 * `*` opens it to any origin, which is only appropriate for a genuinely public
 * read-only API and never grants credentials.
 */
export function resolveOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return null;
  if (!APP.allowedOrigins.length) return null;
  if (APP.allowedOrigins.includes(origin)) return origin;
  return APP.allowedOrigins.includes('*') ? '*' : null;
}

export function applyCors(req, res) {
  const origin = resolveOrigin(req);
  if (!origin) return;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Key');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (origin === '*') return;
  // Credentials are only ever granted to an explicitly named origin — never to
  // a reflected one, which would be the same as granting them to everybody.
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

/**
 * The origin this request arrived on, behind Vercel's proxy.
 *
 * Used to build absolute share links. `x-forwarded-host` is set by the platform
 * and is what makes a link correct on the *.vercel.app URL, on a preview
 * deployment and on a custom domain alike, with no environment variable to keep
 * in sync. It is proxy-controlled input, so it is only ever used to construct a
 * link back to ourselves — never to make an authorisation decision.
 */
export function requestOrigin(req) {
  const host = req.headers?.['x-forwarded-host'] ?? req.headers?.host;
  if (typeof host !== 'string' || !host || !/^[A-Za-z0-9.\-:[\]]+$/.test(host)) return '';
  const forwardedProto = req.headers?.['x-forwarded-proto'];
  const proto =
    typeof forwardedProto === 'string' && forwardedProto
      ? forwardedProto.split(',')[0].trim()
      : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
        ? 'http'
        : 'https';
  if (proto !== 'http' && proto !== 'https') return '';
  return `${proto}://${host}`;
}

/**
 * The origin to put in a shareable link, most specific source first:
 * an explicit PUBLIC_BASE_URL, then the request's own origin, then whatever the
 * platform tells us about this deployment. Returns '' only when nothing knows,
 * in which case callers fall back to a site-relative path.
 */
export function publicBaseUrl(req) {
  return APP.publicUrl || (req ? requestOrigin(req) : '') || APP.platformUrl || '';
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** Parse a JSON body. Works on Vercel (pre-parsed) and on the bare dev server. */
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {};
      try {
        return JSON.parse(req.body);
      } catch {
        throw badRequest('Request body is not valid JSON.');
      }
    }
    return req.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw badRequest('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON.');
  }
}

export function getQuery(req) {
  if (req.query) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Wraps a handler with CORS, preflight handling, method routing and uniform
 * error shaping. Handlers throw `ApiError`; anything else becomes a 500 without
 * leaking internals to the client.
 */
export function createHandler(methods) {
  return async function handler(req, res) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const fn = methods[req.method];
    if (!fn) {
      res.setHeader('Allow', Object.keys(methods).concat('OPTIONS').join(', '));
      sendJson(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} not supported here.` } });
      return;
    }

    try {
      const result = await fn(req, res);
      if (res.writableEnded) return;
      sendJson(res, result?.__status ?? 200, result ?? {});
    } catch (err) {
      if (err instanceof ApiError) {
        sendJson(res, err.status, {
          error: { code: err.code, message: err.message, details: err.details ?? undefined },
        });
        return;
      }
      console.error('[api] unhandled error', err);
      sendJson(res, 500, {
        error: { code: 'internal_error', message: 'Something went wrong on our side. Try again.' },
      });
    }
  };
}

export const withStatus = (status, body) => ({ ...body, __status: status });
