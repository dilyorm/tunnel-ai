import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { sha256 } from '../crypto.js';
import { VERSION } from '../version.js';
import { accountRoutes } from './accounts.js';
import { emailRoutes } from './auth-email.js';
import { githubRoutes } from './auth-github.js';
import { openStore, type Device, type Store } from './db.js';
import { readFeatures, type Env, type Features } from './config.js';
import { HttpError, LIMITS, bearer, clientKey, send, type Handler } from './http.js';
import { createPlans, type Plans } from './plans.js';
import { createStats, NO_STATS, type Stats } from './stats.js';
import { tunnelRoutes } from './tunnels.js';

export { LIMITS } from './http.js';

// The relay is a mailbox for ciphertext. This file is only the HTTP shell: routing, rate limits,
// device auth and the sweep loop. Feature modules register their routes on the App.

export interface RelayOptions {
  port?: number;
  host?: string;
  dataDir: string;
  /** Tunnels one device may own at once. 0 means unlimited. */
  maxTunnelsPerDevice?: number;
  /** Honour X-Forwarded-For when behind a reverse proxy. */
  trustProxy?: boolean;
  /** Feature settings (TUNNEL_PUBLIC_URL, GITHUB_*, …). Nothing set means a plain relay. */
  env?: Env;
  /** Outbound HTTP to GitHub, Resend and Lemon Squeezy. Tests pass a stub. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** How often `tunnel login` polls for approval, in seconds. */
  linkPollSeconds?: number;
}

export interface Relay {
  url: string;
  /** Run the cleanup now instead of waiting for the 10-minute timer. */
  sweep(): Promise<void>;
  close(): Promise<void>;
}

/** What a feature module gets: the store, routing, limiters and device auth. */
export interface App {
  store: Store;
  filesDir: string;
  on(method: string, pattern: string, handler: Handler): void;
  clientOf(req: IncomingMessage): string;
  /** A fixed-window limiter. It counts per client address unless the caller passes a key. */
  counter(windowMs: number, max: number, message: string): (req: IncomingMessage, key?: string) => void;
  /** The device behind the request's bearer token, or a 401. */
  device(req: IncomingMessage): Device;
  features: Features;
  fetch: typeof fetch;
  log(line: string): void;
  linkPollSeconds: number;
  plans: Plans;
  stats: Stats;
  /** Work for the 10-minute sweep (expiry, cleanup). */
  sweeps: (() => void | Promise<void>)[];
}

const HOUR = 60 * 60 * 1000;

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const store = await openStore(options.dataDir);
  const routes: [string, RegExp, Handler][] = [];

  function clientOf(req: IncomingMessage): string {
    // Behind a proxy, the proxy must overwrite X-Forwarded-For; the first entry is trusted.
    // IPv6 clients are keyed by their /64 (see clientKey), so rotating addresses doesn't dodge a limit.
    const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '') : '';
    return clientKey(forwarded.split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
  }

  function counter(windowMs: number, max: number, message: string) {
    let start = Date.now();
    const hits = new Map<string, number>();
    return (req: IncomingMessage, key = clientOf(req)) => {
      const now = Date.now();
      if (now - start > windowMs) {
        start = now;
        hits.clear();
      }
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      if (n > max) throw new HttpError(429, message);
    };
  }

  const log = options.log ?? ((line: string) => console.log(`[relay] ${line}`));
  const features = readFeatures(options.env ?? {}, log);

  const app: App = {
    store,
    filesDir: join(options.dataDir, 'files'),
    plans: createPlans(store, {
      freeCap: options.maxTunnelsPerDevice ?? 0,
      upgradeHint: Boolean(features.billing),
    }),
    on(method, pattern, handler) {
      routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), handler]);
    },
    clientOf,
    counter,
    features,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    log,
    linkPollSeconds: options.linkPollSeconds ?? 3,
    device(req) {
      const row = store.deviceByToken.get(sha256(bearer(req)));
      if (!row) throw new HttpError(401, 'Unknown device.');
      const now = Date.now();
      if (row.seen === null || now - row.seen > HOUR) store.touchDevice.run(now, row.id);
      app.stats.active('device', row.id);
      return row;
    },
    stats: NO_STATS,
    sweeps: [],
  };

  // Stats feed the admin page, so they run only on a relay that has one.
  if (features.adminEmails.size > 0) app.stats = createStats(app);

  const limit = counter(60_000, LIMITS.requestsPerMinute, 'Too many requests. Slow down and retry in a minute.');

  app.on('GET', '/v1/health', async (_req, res) => send(res, 200, { ok: true, version: VERSION }));
  const tunnels = tunnelRoutes(app);

  if (features.publicUrl) {
    const accounts = accountRoutes(app);
    if (features.email) emailRoutes(app, accounts, features.email);
    if (features.github) githubRoutes(app, accounts, features.github);
  }

  const server = createServer(async (req, res) => {
    try {
      limit(req);
      const target = req.url ?? '/';
      const url = new URL(target, 'http://relay');
      // Parsing turns `\` into `/` and resolves `.` and `..` (also as %2e), so a path nginx forwarded as
      // an ordinary /v1/ path could land on a route nginx never meant to expose (/internal/install).
      // Every real client sends a canonical path, so anything the parser would rewrite is refused.
      if (target.split('?')[0] !== url.pathname) throw new HttpError(400, 'Bad request path.');
      for (const [method, re, handler] of routes) {
        const match = re.exec(url.pathname);
        if (match && method === req.method) {
          await handler(req, res, match.slice(1).map(decodeURIComponent), url);
          return;
        }
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      // A handler may refuse before reading the body (an upload over the limit). Drain the rest,
      // or the client is still sending when the reply comes and sees a reset instead of the error.
      if (!req.complete) req.resume();
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error('[relay]', error);
        send(res, 500, { error: 'Relay error.' });
      }
    }
  });
  // A 100 MB upload on a slow link can take many minutes, so there is no total request time limit.
  // A socket that sends nothing for 2 minutes is dropped instead. Long-polls wait at most 55 s.
  server.requestTimeout = 0;
  server.timeout = 120_000;
  server.keepAliveTimeout = 65_000;

  async function sweep() {
    for (const fn of app.sweeps) {
      try {
        await fn();
      } catch (error) {
        console.error('[relay] sweep failed', error);
      }
    }
  }
  const timer = setInterval(() => void sweep(), 10 * 60 * 1000);
  timer.unref();
  await sweep();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', resolve);
  });
  const address = server.address() as AddressInfo;
  const host = !options.host || options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;

  return {
    url: `http://${host}:${address.port}`,
    sweep,
    async close() {
      clearInterval(timer);
      tunnels.wakeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
