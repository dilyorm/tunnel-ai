import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

// Helpers shared by every route module. An HttpError reaches the client as {"error": message};
// anything else thrown in a handler is a relay bug and becomes a 500.

export const LIMITS = {
  messageBytes: 96 * 1024, // sealed + base64 form of a 64 KB message
  profileBytes: 2 * 1024,
  fileBytes: 10 * 1024 * 1024 + 64,
  jsonBody: 256 * 1024,
  inviteTtlMs: 15 * 60 * 1000,
  inviteAttempts: 3,
  maxWaitS: 55,
  requestsPerMinute: 600,
  devicesPerHour: 10,
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
