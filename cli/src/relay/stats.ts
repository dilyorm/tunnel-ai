import { createHmac } from 'node:crypto';
import { sha256 } from '../crypto.js';
import { HttpError, body, send } from './http.js';
import type { App } from './server.js';

// Daily counters for the admin page. Nothing here identifies a person: visitor hashes are keyed by a
// salt that changes every day and are deleted when the day ends, and no address or cookie is stored.

export const METRICS = [
  'messages',
  'files',
  'file_bytes',
  'tunnels_opened',
  'joins',
  'devices_created',
  'signups',
  'logins',
  'checkouts',
  'page_views',
  'unique_visitors',
  'installs_sh',
  'installs_ps1',
  'installs_npm',
] as const;

export type Metric = (typeof METRICS)[number];

export interface Stats {
  count(metric: Metric, n?: number): void;
  /** Mark a machine (device token) or an agent (tunnel member) as active today. */
  active(kind: 'device' | 'member', id: string): void;
}

/** For relays without an admin: nothing is counted. */
export const NO_STATS: Stats = { count() {}, active() {} };

const DAY = 24 * 60 * 60 * 1000;
const BOT = /bot|crawl|spider|slurp|preview|headless/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// A referrer is stored only if it looks like a real host name. Anyone can send the beacon, so the
// table must not take arbitrary strings, and it takes only so many new hosts a day.
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const MAX_REFERRERS_PER_DAY = 500;

/** The UTC day, as stored: 'YYYY-MM-DD'. */
export const dayOf = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

/** Which install a download nginx mirrored to us counts as, if any. */
export function installMetric(path: string, userAgent: string): Metric | undefined {
  const file = path.split('?')[0];
  if (file === '/install.sh') return 'installs_sh';
  if (file === '/install.ps1') return 'installs_ps1';
  // The install scripts fetch the tarball with curl or PowerShell; only npm's own fetch is a separate install.
  if (/^\/tunnel-ai(-[\w.-]+)?\.tgz$/.test(file) && userAgent.startsWith('npm/')) return 'installs_npm';
  return undefined;
}

function referrerHost(raw: Buffer): string | undefined {
  try {
    const { r } = JSON.parse(raw.toString('utf8')) as { r?: unknown };
    if (typeof r !== 'string' || !r) return undefined;
    const url = new URL(r);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.hostname.length <= 253 && HOST.test(url.hostname) ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

export function createStats(app: App): Stats {
  const { store, features } = app;
  const s = {
    bump: store.prepare(
      `INSERT INTO stats_daily (day, metric, n) VALUES (?, ?, ?)
       ON CONFLICT(day, metric) DO UPDATE SET n = n + excluded.n`,
    ),
    device: store.prepare('INSERT OR IGNORE INTO active_devices (day, device_id) VALUES (?, ?)'),
    member: store.prepare('INSERT OR IGNORE INTO active_members (day, member_id) VALUES (?, ?)'),
    visitor: store.prepare('INSERT OR IGNORE INTO visitors (day, hash) VALUES (?, ?)'),
    referrer: store.prepare(
      'INSERT INTO referrers (day, host, n) VALUES (?, ?, 1) ON CONFLICT(day, host) DO UPDATE SET n = n + 1',
    ),
    dropVisitors: store.prepare('DELETE FROM visitors WHERE day < ?'),
    dropOld: [
      store.prepare('DELETE FROM active_devices WHERE day < ?'),
      store.prepare('DELETE FROM active_members WHERE day < ?'),
      store.prepare('DELETE FROM referrers WHERE day < ?'),
    ],
  };

  // Ids already written today, so a busy agent costs one insert a day, not one per request, and the
  // referrer hosts already stored today, for the daily cap.
  let today = '';
  const seen = new Set<string>();
  const referrers = new Set<string>();

  function rollover(day: string) {
    if (day === today) return;
    today = day;
    seen.clear();
    referrers.clear();
  }

  // Counting must never fail the request it describes: by the time a counter runs, the tunnel, message
  // or file is already saved, and a 500 would make the client retry or lose what the relay handed out.
  const stats: Stats = {
    count(metric, n = 1) {
      try {
        if (n > 0) s.bump.run(dayOf(), metric, n);
      } catch (error) {
        app.log(`stats: could not count ${metric}: ${(error as Error).message}`);
      }
    },
    active(kind, id) {
      try {
        const day = dayOf();
        rollover(day);
        if (seen.has(id)) return;
        (kind === 'device' ? s.device : s.member).run(day, id);
        seen.add(id); // only once it is stored, so a failed write is tried again on the next request
      } catch (error) {
        app.log(`stats: could not mark a ${kind} active: ${(error as Error).message}`);
      }
    },
  };

  const ownHost = features.publicUrl ? new URL(features.publicUrl).hostname : '';

  // The site sends {p, r} with navigator.sendBeacon as text/plain, so there is no CORS preflight.
  app.on('POST', '/v1/hit', async (req, res) => {
    const raw = await body(req, 4096);
    const userAgent = String(req.headers['user-agent'] ?? '');
    if (!userAgent || BOT.test(userAgent)) return send(res, 204);
    const day = dayOf();
    stats.count('page_views');
    if (features.statsSalt) {
      const dayKey = createHmac('sha256', features.statsSalt).update(day).digest('hex');
      const hash = sha256(`${dayKey}${app.clientOf(req)}\0${userAgent}`);
      if (Number(s.visitor.run(day, hash).changes) > 0) stats.count('unique_visitors');
    }
    const host = referrerHost(raw);
    if (host && host !== ownHost) {
      rollover(day);
      // A host already stored today always counts; new ones stop at the cap. The view is counted either way.
      if (referrers.has(host) || referrers.size < MAX_REFERRERS_PER_DAY) {
        s.referrer.run(day, host);
        referrers.add(host);
      }
    }
    send(res, 204);
  });

  // nginx mirrors install downloads here over loopback. Outside /v1/, so the public can't reach it
  // through the proxy; the socket check refuses anyone else who finds the port.
  app.on('GET', '/internal/install', async (req, res, _params, url) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) throw new HttpError(404, 'Not found.');
    const metric = installMetric(url.searchParams.get('f') ?? '', String(req.headers['user-agent'] ?? ''));
    if (metric) stats.count(metric);
    send(res, 204);
  });

  app.sweeps.push(() => {
    const now = Date.now();
    s.dropVisitors.run(dayOf(now));
    const cutoff = dayOf(now - 90 * DAY);
    for (const stmt of s.dropOld) stmt.run(cutoff);
  });

  return stats;
}
