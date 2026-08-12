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

function resolveOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return null;
  if (APP.allowedOrigins.includes('*')) return origin;
  return APP.allowedOrigins.includes(origin) ? origin : null;
}

export function applyCors(req, res) {
  const origin = resolveOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
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
