import type { IncomingMessage } from 'node:http';
import type { Accounts } from './accounts.js';
import type { Account } from './db.js';
import { HttpError, json, send } from './http.js';
import { PRICES, planNamed, type PlanName } from './plans.js';
import type { Recompute } from './billing/index.js';
import type { App } from './server.js';
import { METRICS, dayOf } from './stats.js';

// The owner's view: daily counts, who is active, what plans people are on, and plan grants.
// Admins are the emails in TUNNEL_ADMIN_EMAILS. Everyone else gets the router's own 404.

export const SERIES = [...METRICS, 'active_devices', 'active_members'] as const;
type Series = (typeof SERIES)[number];

const DAY = 24 * 60 * 60 * 1000;
const PAGE = 50;

interface AccountRow {
  id: string;
  email: string;
  github_login: string | null;
  plan: PlanName;
  plan_source: string | null;
  plan_until: number | null;
  created: number;
  seen: number;
  devices: number;
  tunnels: number;
}

export function adminRoutes(app: App, accounts: Accounts, recompute: Recompute) {
  const { store } = app;
  const s = {
    daily: store.prepare<{ day: string; metric: string; n: number }>(
      'SELECT day, metric, n FROM stats_daily WHERE day >= ?',
    ),
    activeDaily: store.prepare<{ day: string; metric: string; n: number }>(
      `SELECT day, 'active_devices' AS metric, COUNT(*) AS n FROM active_devices WHERE day >= ?1 GROUP BY day
       UNION ALL
       SELECT day, 'active_members' AS metric, COUNT(*) AS n FROM active_members WHERE day >= ?1 GROUP BY day`,
    ),
    agents: store.prepare<{ n: number }>('SELECT COUNT(DISTINCT member_id) AS n FROM active_members WHERE day >= ?'),
    devices: store.prepare<{ n: number }>('SELECT COUNT(DISTINCT device_id) AS n FROM active_devices WHERE day >= ?'),
    // Signed in on the site, or used a linked machine.
    activeAccounts: store.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM accounts a
        WHERE a.seen >= ?1
           OR EXISTS (SELECT 1 FROM active_devices ad JOIN devices d ON d.id = ad.device_id
                       WHERE d.account_id = a.id AND ad.day >= ?2)`,
    ),
    plans: store.prepare<{ plan: PlanName; n: number }>('SELECT plan, COUNT(*) AS n FROM accounts GROUP BY plan'),
    paying: store.prepare<{ plan: PlanName; n: number }>(
      "SELECT plan, COUNT(*) AS n FROM accounts WHERE plan_source = 'billing' GROUP BY plan",
    ),
    referrers: store.prepare<{ host: string; n: number }>(
      'SELECT host, SUM(n) AS n FROM referrers WHERE day >= ? GROUP BY host ORDER BY n DESC, host LIMIT 10',
    ),
    // One extra row tells us whether there is a next page.
    accounts: store.prepare<AccountRow>(
      `SELECT a.id, a.email, a.github_login, a.plan, a.plan_source, a.plan_until, a.created, a.seen,
              (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS devices,
              (SELECT COUNT(*) FROM tunnels t JOIN devices d ON d.id = t.owner_device WHERE d.account_id = a.id) AS tunnels
         FROM accounts a
        WHERE ?1 = '' OR a.email LIKE ?2 ESCAPE '\\' OR a.github_login LIKE ?2 ESCAPE '\\'
        ORDER BY a.created DESC, a.id
        LIMIT ${PAGE + 1} OFFSET ?3`,
    ),
    grant: store.prepare("UPDATE accounts SET plan = ?, plan_source = 'admin', plan_until = ? WHERE id = ?"),
    clearGrant: store.prepare(
      "UPDATE accounts SET plan_source = NULL, plan_until = NULL WHERE id = ? AND plan_source = 'admin'",
    ),
  };

  function requireAdmin(req: IncomingMessage): Account {
    const account = accounts.session(req);
    if (!account || !accounts.isAdmin(account)) throw new HttpError(404, 'Not found.');
    return account;
  }

  /** Distinct actives over the last 1, 7 and 30 days, today included. */
  function windows(count: (since: string, sinceMs: number) => number) {
    const at = (days: number) => {
      const since = dayOf(Date.now() - (days - 1) * DAY);
      return count(since, Date.parse(`${since}T00:00:00Z`));
    };
    return { d1: at(1), d7: at(7), d30: at(30) };
  }

  app.on('GET', '/v1/admin/stats', async (req, res, _params, url) => {
    requireAdmin(req);
    const span = Math.min(90, Math.max(1, Math.floor(Number(url.searchParams.get('days') ?? 30)) || 30));
    const now = Date.now();
    const days = Array.from({ length: span }, (_, i) => dayOf(now - (span - 1 - i) * DAY));
    const index = new Map(days.map((day, i) => [day, i]));
    const series = Object.fromEntries(SERIES.map((name) => [name, days.map(() => 0)])) as Record<Series, number[]>;
    for (const row of [...s.daily.all(days[0]), ...s.activeDaily.all(days[0])]) {
      const i = index.get(row.day);
      const line = series[row.metric as Series];
      if (i !== undefined && line) line[i] = row.n;
    }
    const today = Object.fromEntries(SERIES.map((name) => [name, series[name][span - 1]])) as Record<Series, number>;

    const plans: Record<PlanName, number> = { free: 0, plus: 0, pro: 0 };
    for (const row of s.plans.all()) if (planNamed(row.plan)) plans[row.plan] = row.n;
    let mrr = 0;
    for (const row of s.paying.all()) if (row.plan === 'plus' || row.plan === 'pro') mrr += PRICES[row.plan] * row.n;

    send(res, 200, {
      days,
      series,
      today,
      active: {
        agents: windows((since) => s.agents.get(since)?.n ?? 0),
        devices: windows((since) => s.devices.get(since)?.n ?? 0),
        accounts: windows((since, sinceMs) => s.activeAccounts.get(sinceMs, since)?.n ?? 0),
      },
      plans,
      mrr,
      referrers: s.referrers.all(days[0]),
    });
  });

  app.on('GET', '/v1/admin/accounts', async (req, res, _params, url) => {
    requireAdmin(req);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // The cursor is the number of accounts already shown. SQLite refuses an OFFSET that isn't a whole number.
    const cursor = Number(url.searchParams.get('cursor') ?? 0);
    const offset = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : 0;
    const rows = s.accounts.all(q, pattern, offset);
    send(res, 200, {
      accounts: rows.slice(0, PAGE).map((row) => ({
        id: row.id,
        email: row.email,
        githubLogin: row.github_login,
        plan: row.plan,
        planSource: row.plan_source,
        planUntil: row.plan_until,
        created: row.created,
        seen: row.seen,
        devices: row.devices,
        tunnels: row.tunnels,
      })),
      next: rows.length > PAGE ? String(offset + PAGE) : null,
    });
  });

  app.on('POST', '/v1/admin/accounts/:id/plan', async (req, res, [id]) => {
    requireAdmin(req);
    accounts.requireOrigin(req);
    const input = await json<{ plan?: unknown; until?: unknown }>(req);
    if (!accounts.byId(id)) throw new HttpError(404, 'No account with that id.');
    if (input.plan === null) {
      // Back to whatever billing says.
      s.clearGrant.run(id);
      recompute.account(id);
    } else {
      const plan = planNamed(input.plan);
      if (!plan) throw new HttpError(400, 'Plan must be free, plus, pro or null.');
      const until = input.until ?? null;
      if (until !== null && !(typeof until === 'number' && Number.isSafeInteger(until) && until > Date.now())) {
        throw new HttpError(400, 'The end date must be in the future.');
      }
      s.grant.run(plan, until, id);
    }
    const account = accounts.byId(id)!;
    send(res, 200, { plan: account.plan, planSource: account.plan_source, planUntil: account.plan_until });
  });
}
