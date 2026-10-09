import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

// Helpers shared by every route module. An HttpError reaches the client as {"error": message};
// anything else thrown in a handler is a relay bug and becomes a 500.

export const LIMITS = {
  messageBytes: 96 * 1024, // sealed + base64 form of a 64 KB message
  profileBytes: 2 * 1024,
  jsonBody: 256 * 1024,
  inviteTtlMs: 15 * 60 * 1000,
  inviteAttempts: 3,
  maxWaitS: 55,
  requestsPerMinute: 600,
  devicesPerHour: 10,
  loginEmailsPerAddress: 5,
  loginEmailsPerClient: 20,
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>;

export async function body(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `Body too large (limit ${max} bytes).`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function json<T>(req: IncomingMessage, max = LIMITS.jsonBody): Promise<T> {
  const raw = await body(req, max);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Body is not valid JSON.');
  }
  // `null` or `5` would make handlers throw a TypeError (a 500); refuse them here instead.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Body must be a JSON object.');
  }
  return value as T;
}

export function str(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `Missing ${name}.`);
  if (value.length > max) throw new HttpError(413, `${name} is too large.`);
  return value;
}

export function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'Missing token.');
  return match[1];
}

export function send(res: ServerResponse, status: number, payload?: unknown, headers: OutgoingHttpHeaders = {}) {
  if (payload === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

/** Cookies sent with the request. Ours are base64url or "1", so values are used as sent. */
export function cookies(req: IncomingMessage): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

/** A Set-Cookie value. Max-Age 0 deletes the cookie. */
export function setCookie(name: string, value: string, maxAgeS: number, options: { secure: boolean; httpOnly: boolean }) {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${maxAgeS}`, 'SameSite=Lax'];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function redirect(res: ServerResponse, location: string, setCookies: string[] = []) {
  const headers: OutgoingHttpHeaders = { location, 'cache-control': 'no-store' };
  if (setCookies.length) headers['set-cookie'] = setCookies;
  res.writeHead(302, headers).end();
}

/**
 * Where to send someone after sign-in: a path on this site, else /account. "//host" and "/\host"
 * are other sites to a browser, and browsers drop tabs and newlines, so "/<tab>/host" is one too.
 */
export function safeReturn(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/account';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return '/account';
  return value;
}
