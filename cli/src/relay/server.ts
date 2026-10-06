import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomInt } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { secretToken, sha256, shortId } from '../crypto.js';
import { VERSION } from '../version.js';
import { openStore, type Member, type Store } from './db.js';

// The relay is a mailbox for ciphertext. It never sees tunnel keys, names or message text:
// it stores sealed blobs, hands them to members holding a bearer token, and wakes long-polls.

export interface RelayOptions {
  port?: number;
  host?: string;
  dataDir: string;
  /** Tunnels one device may own at once. 0 means unlimited. */
  maxTunnelsPerDevice?: number;
  /** How long messages and files are kept. */
  ttlMs?: number;
  /** Honour X-Forwarded-For when behind a reverse proxy. */
  trustProxy?: boolean;
}

export interface Relay {
  url: string;
  close(): Promise<void>;
}

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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DAY = 24 * 60 * 60 * 1000;

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const store = await openStore(options.dataDir);
  const filesDir = join(options.dataDir, 'files');
  const ttl = options.ttlMs ?? 7 * DAY;
  const maxTunnels = options.maxTunnelsPerDevice ?? 0;

  // ---------- long-poll wakeups ----------

  const waiters = new Map<string, Set<() => void>>();

  function wake(tunnelId: string) {
    const set = waiters.get(tunnelId);
    if (!set) return;
    waiters.delete(tunnelId);
    for (const fn of set) fn();
  }

  function waitForMessage(tunnelId: string, ms: number, res: ServerResponse) {
    return new Promise<void>((resolve) => {
      const set = waiters.get(tunnelId) ?? new Set<() => void>();
      waiters.set(tunnelId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        res.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      res.on('close', done);
    });
  }

  // ---------- rate limiting (fixed windows per client address) ----------

  function clientOf(req: IncomingMessage): string {
    // Behind a proxy, the proxy must overwrite X-Forwarded-For; the first entry is trusted.
    const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '') : '';
    return forwarded.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  }

  function counter(windowMs: number, max: number, message: string) {
    let start = Date.now();
    const hits = new Map<string, number>();
    return (req: IncomingMessage) => {
      const now = Date.now();
      if (now - start > windowMs) {
        start = now;
        hits.clear();
      }
      const client = clientOf(req);
      const n = (hits.get(client) ?? 0) + 1;
      hits.set(client, n);
      if (n > max) throw new HttpError(429, message);
    };
  }

  const limit = counter(60_000, LIMITS.requestsPerMinute, 'Too many requests. Slow down and retry in a minute.');
  // Devices cost nothing to mint, so the per-device tunnel cap is only as strong as this limit.
  const limitDevices = counter(
    60 * 60_000,
    LIMITS.devicesPerHour,
    'Too many new devices from this address. Try again in an hour.',
  );

  // ---------- helpers ----------

  async function body(req: IncomingMessage, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) throw new HttpError(413, `Body too large (limit ${max} bytes).`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function json<T>(req: IncomingMessage): Promise<T> {
    const raw = await body(req, LIMITS.jsonBody);
    try {
      return JSON.parse(raw.toString('utf8') || '{}') as T;
    } catch {
      throw new HttpError(400, 'Body is not valid JSON.');
    }
  }

  function str(value: unknown, name: string, max: number): string {
    if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `Missing ${name}.`);
    if (value.length > max) throw new HttpError(413, `${name} is too large.`);
    return value;
  }

  function bearer(req: IncomingMessage): string {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new HttpError(401, 'Missing token.');
    return match[1];
  }

  function device(req: IncomingMessage) {
    const row = store.deviceByToken.get(sha256(bearer(req)));
    if (!row) throw new HttpError(401, 'Unknown device.');
    return row.id;
  }

  function member(req: IncomingMessage, tunnelId: string): Member {
    const row = store.memberByToken.get(sha256(bearer(req)));
    if (!row || row.tunnel_id !== tunnelId) {
      throw new HttpError(404, 'Tunnel not found, or you are no longer a member.');
    }
    const now = Date.now();
    if (now - row.seen > 30_000) store.touchMember.run(now, row.id);
    return row;
  }

  function send(res: ServerResponse, status: number, payload?: unknown) {
    if (payload === undefined) {
      res.writeHead(status).end();
      return;
    }
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  }

  function freeSlot(): number {
    store.deleteExpiredInvites.run(Date.now());
    const used = new Set(store.usedSlots.all().map((r) => r.slot));
    const ceiling = used.size < 800 ? 999 : used.size < 8000 ? 9999 : 99999;
    for (let i = 0; i < 50; i++) {
      const slot = randomInt(1, ceiling + 1);
      if (!used.has(slot)) return slot;
    }
    throw new HttpError(503, 'No free invite slots right now. Try again in a minute.');
  }

  async function removeTunnel(tunnelId: string) {
    const files = store.tunnelFiles.all(tunnelId);
    store.deleteTunnel.run(tunnelId);
    await Promise.all(files.map((f) => unlink(join(filesDir, f.id)).catch(() => {})));
    wake(tunnelId);
  }

  // ---------- routes ----------

  type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>;
  const routes: [string, RegExp, Handler][] = [];
  const on = (method: string, pattern: string, handler: Handler) => {
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$');
    routes.push([method, re, handler]);
  };

  on('GET', '/v1/health', async (_req, res) => send(res, 200, { ok: true, version: VERSION }));

  on('POST', '/v1/devices', async (req, res) => {
    limitDevices(req);
    const id = shortId('d', 14);
    const token = secretToken();
    store.insertDevice.run(id, sha256(token), Date.now());
    send(res, 201, { deviceId: id, deviceToken: token });
  });

  on('POST', '/v1/tunnels', async (req, res) => {
    const deviceId = device(req);
    const input = await json<{ profile?: string }>(req);
    if (maxTunnels > 0 && (store.countTunnels.get(deviceId)?.n ?? 0) >= maxTunnels) {
      throw new HttpError(
        402,
        `This relay allows ${maxTunnels} open tunnel${maxTunnels === 1 ? '' : 's'} per device. ` +
          'Close one with `tunnel close`, or see https://tunnel.dilyor.dev/#pricing.',
      );
    }
    const now = Date.now();
    const tunnelId = shortId('t', 16);
    const memberId = shortId('m', 12);
    const token = secretToken();
    const profile = input.profile ? str(input.profile, 'profile', LIMITS.profileBytes) : null;
    store.insertTunnel.run(tunnelId, deviceId, memberId, now);
    store.insertMember.run(memberId, tunnelId, sha256(token), profile, now, now);
    send(res, 201, { tunnelId, memberId, memberToken: token });
  });

  on('DELETE', '/v1/tunnels/:tid', async (req, res, [tid]) => {
    const me = member(req, tid);
    const tunnel = store.tunnel.get(tid);
    if (!tunnel) throw new HttpError(404, 'Tunnel not found.');
    if (tunnel.owner_member !== me.id) {
      throw new HttpError(403, 'Only the agent that opened this tunnel can close it. Use `tunnel leave` instead.');
    }
    await removeTunnel(tid);
    send(res, 204);
  });

  on('POST', '/v1/tunnels/:tid/invites', async (req, res, [tid]) => {
    member(req, tid);
    const input = await json<{ salt?: string; wrapped?: string; verifierHash?: string }>(req);
    const salt = str(input.salt, 'salt', 64);
    const wrapped = str(input.wrapped, 'wrapped', 4096);
    const verifierHash = str(input.verifierHash, 'verifierHash', 128);
    const slot = freeSlot();
    const expires = Date.now() + LIMITS.inviteTtlMs;
    store.insertInvite.run(slot, tid, salt, wrapped, verifierHash, expires);
    send(res, 201, { slot, expiresAt: expires });
  });

  on('GET', '/v1/invites/:slot', async (_req, res, [slot]) => {
    const invite = store.invite.get(Number(slot), Date.now());
    if (!invite) throw new HttpError(404, 'That invite code has expired or was already used.');
    send(res, 200, { salt: invite.salt });
  });

  on('POST', '/v1/invites/:slot/claim', async (req, res, [slot]) => {
    const input = await json<{ verifier?: string }>(req);
    const verifier = str(input.verifier, 'verifier', 128);
    const invite = store.invite.get(Number(slot), Date.now());
    if (!invite) throw new HttpError(404, 'That invite code has expired or was already used.');
    if (sha256(verifier) !== invite.verifier_hash) {
      const attempts = store.failInvite.get(invite.slot)?.attempts ?? LIMITS.inviteAttempts;
      if (attempts >= LIMITS.inviteAttempts) {
        store.deleteInvite.run(invite.slot);
        throw new HttpError(410, 'Wrong code too many times, so the invite was cancelled. Ask for a new one.');
      }
      throw new HttpError(403, 'Wrong invite code. Check the words and try again.');
    }
    store.deleteInvite.run(invite.slot);
    const now = Date.now();
    const memberId = shortId('m', 12);
    const token = secretToken();
    store.insertMember.run(memberId, invite.tunnel_id, sha256(token), null, now, now);
    send(res, 200, { tunnelId: invite.tunnel_id, wrapped: invite.wrapped, memberId, memberToken: token });
  });

  on('GET', '/v1/tunnels/:tid/members', async (req, res, [tid]) => {
    const me = member(req, tid);
    const tunnel = store.tunnel.get(tid);
    const members = store.members.all(tid).map((m) => ({
      id: m.id,
      profile: m.profile,
      seen: m.seen,
      you: m.id === me.id,
      owner: m.id === tunnel?.owner_member,
    }));
    send(res, 200, { members });
  });

  on('PUT', '/v1/tunnels/:tid/members/me', async (req, res, [tid]) => {
    const me = member(req, tid);
    const input = await json<{ profile?: string }>(req);
    store.setProfile.run(str(input.profile, 'profile', LIMITS.profileBytes), me.id);
    send(res, 204);
  });

  on('DELETE', '/v1/tunnels/:tid/members/me', async (req, res, [tid]) => {
    const me = member(req, tid);
    store.deleteMember.run(me.id);
    if ((store.countMembers.get(tid)?.n ?? 0) === 0) await removeTunnel(tid);
    send(res, 204);
  });

  on('POST', '/v1/tunnels/:tid/messages', async (req, res, [tid]) => {
    const me = member(req, tid);
    const input = await json<{ ct?: string }>(req);
    const ct = str(input.ct, 'ct', LIMITS.messageBytes);
    const row = store.bumpSeq.get(tid);
    if (!row) throw new HttpError(404, 'Tunnel not found.');
    store.insertMessage.run(tid, row.seq, me.id, ct, Date.now());
    wake(tid);
    send(res, 201, { seq: row.seq });
  });

  on('GET', '/v1/tunnels/:tid/messages', async (req, res, [tid], url) => {
    member(req, tid);
    const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const waitS = Math.min(LIMITS.maxWaitS, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));

    let rows = store.messagesAfter.all(tid, after, limit);
    if (rows.length === 0 && waitS > 0) {
      await waitForMessage(tid, waitS * 1000, res);
      if (res.destroyed) return;
      rows = store.messagesAfter.all(tid, after, limit);
    }
    const tunnel = store.tunnel.get(tid);
    if (!tunnel) throw new HttpError(404, 'This tunnel was closed.');
    send(res, 200, {
      messages: rows.map((r) => ({ seq: r.seq, from: r.member_id, ct: r.ct, at: r.created })),
      latest: tunnel.seq,
    });
  });

  on('POST', '/v1/tunnels/:tid/files', async (req, res, [tid]) => {
    const me = member(req, tid);
    const data = await body(req, LIMITS.fileBytes);
    if (data.length === 0) throw new HttpError(400, 'Empty file.');
    const id = shortId('f', 10);
    await writeFile(join(filesDir, id), data);
    store.insertFile.run(id, tid, me.id, data.length, Date.now());
    send(res, 201, { fileId: id, size: data.length });
  });

  on('GET', '/v1/tunnels/:tid/files/:fid', async (req, res, [tid, fid]) => {
    member(req, tid);
    const file = store.file.get(fid);
    if (!file || file.tunnel_id !== tid) throw new HttpError(404, 'File not found. Files are kept for 7 days.');
    const data = await readFile(join(filesDir, file.id));
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  });

  // ---------- server ----------

  const server = createServer(async (req, res) => {
    try {
      limit(req);
      const url = new URL(req.url ?? '/', 'http://relay');
      for (const [method, re, handler] of routes) {
        const match = re.exec(url.pathname);
        if (match && method === req.method) {
          await handler(req, res, match.slice(1).map(decodeURIComponent), url);
          return;
        }
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error('[relay]', error);
        send(res, 500, { error: 'Relay error.' });
      }
    }
  });
  // long-polls hold requests open; keep sockets alive a little longer than the longest wait
  server.requestTimeout = (LIMITS.maxWaitS + 30) * 1000;
  server.keepAliveTimeout = 65_000;

  const sweep = setInterval(() => cleanup(store, filesDir, ttl), 10 * 60 * 1000);
  sweep.unref();
  await cleanup(store, filesDir, ttl);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', resolve);
  });
  const address = server.address() as AddressInfo;
  const host = !options.host || options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;

  return {
    url: `http://${host}:${address.port}`,
    async close() {
      clearInterval(sweep);
      for (const id of [...waiters.keys()]) wake(id);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

async function cleanup(store: Store, filesDir: string, ttl: number) {
  const cutoff = Date.now() - ttl;
  store.deleteExpiredInvites.run(Date.now());
  store.deleteOldMessages.run(cutoff);
  const old = store.oldFiles.all(cutoff);
  store.deleteOldFiles.run(cutoff);
  await Promise.all(old.map((f) => unlink(join(filesDir, f.id)).catch(() => {})));
}
