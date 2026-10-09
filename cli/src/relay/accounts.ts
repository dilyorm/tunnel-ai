import { randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { secretToken, sha256, shortId } from '../crypto.js';
import type { Account } from './db.js';
import { HttpError, cookies, json, send, setCookie } from './http.js';
import type { App } from './server.js';

// Accounts are optional: a device works without one. An account holds the plan and the machines
// linked to it, and a browser reaches it through a session cookie.

export const SESSION_COOKIE = 'tunnel_session';
/** Not secret. Lets static pages show "Account" instead of "Sign in" without asking the relay. */
export const HINT_COOKIE = 'tunnel_signed_in';
const SESSION_S = 30 * 24 * 60 * 60;
const HOUR = 60 * 60 * 1000;

export interface Accounts {
  byId(id: string): Account | undefined;
  /** The signed-in account, if the session cookie is valid. */
  session(req: IncomingMessage): Account | undefined;
  /** The signed-in account, or a 401. */
  requireSession(req: IncomingMessage): Account;
  /** Browser POSTs must come from our own pages, or a 403. */
  requireOrigin(req: IncomingMessage): void;
  /** A new session for this account, as Set-Cookie values. */
  startSession(accountId: string): string[];
  upsertByEmail(email: string): Account;
  /**
   * The account with this GitHub id, else the one with this email, else a new one.
   * undefined: the email belongs to an account already linked to another GitHub user.
   */
  upsertGithub(user: { id: number; login: string; email: string }): Account | undefined;
  isAdmin(account: Account): boolean;
}

export function accountRoutes(app: App): Accounts {
  const { store, features } = app;
  // server.ts only calls this when a public URL is set.
  const publicUrl = features.publicUrl!;
  const secure = !publicUrl.startsWith('http://');

  const s = {
    byId: store.prepare<Account>('SELECT * FROM accounts WHERE id = ?'),
    byEmail: store.prepare<Account>('SELECT * FROM accounts WHERE email = ?'),
    byGithub: store.prepare<Account>('SELECT * FROM accounts WHERE github_id = ?'),
    create: store.prepare(
      'INSERT INTO accounts (id, email, created, seen) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING',
    ),
    setGithub: store.prepare('UPDATE accounts SET github_id = ?, github_login = ? WHERE id = ?'),
    touch: store.prepare('UPDATE accounts SET seen = ? WHERE id = ?'),
    session: store.prepare<Account>(
      'SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?',
    ),
    insertSession: store.prepare('INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?, ?, ?, ?)'),
    deleteSession: store.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    devices: store.prepare<{ id: string; created: number; seen: number | null; tunnels: number }>(
      `SELECT d.id, d.created, d.seen, (SELECT COUNT(*) FROM tunnels t WHERE t.owner_device = d.id) AS tunnels
         FROM devices d WHERE d.account_id = ? ORDER BY d.created`,
    ),
    unlink: store.prepare('UPDATE devices SET account_id = NULL WHERE id = ? AND account_id = ?'),
    expired: [
      store.prepare('DELETE FROM sessions WHERE expires <= ?'),
      store.prepare('DELETE FROM email_logins WHERE expires <= ?'),
      store.prepare('DELETE FROM oauth_states WHERE expires <= ?'),
      store.prepare('DELETE FROM device_links WHERE expires <= ?'),
    ],
  };

  function create(email: string): Account {
    const now = Date.now();
    if (Number(s.create.run(shortId('a', 12), email, now, now).changes) > 0) app.stats.count('signups');
    return s.byEmail.get(email)!;
  }

  const accounts: Accounts = {
    byId: (id) => s.byId.get(id),
    session(req) {
      const token = cookies(req)[SESSION_COOKIE];
      if (!token) return undefined;
      const now = Date.now();
      const account = s.session.get(sha256(token), now);
      if (account && now - account.seen > HOUR) s.touch.run(now, account.id);
      return account;
    },
    requireSession(req) {
      const account = accounts.session(req);
      if (!account) throw new HttpError(401, 'Sign in first.');
      return account;
    },
    requireOrigin(req) {
      if (req.headers.origin !== publicUrl) {
        throw new HttpError(403, 'This request came from another site, so it was blocked.');
      }
    },
    startSession(accountId) {
      const token = secretToken();
      const now = Date.now();
      s.insertSession.run(sha256(token), accountId, now, now + SESSION_S * 1000);
      app.stats.count('logins');
      return [
        setCookie(SESSION_COOKIE, token, SESSION_S, { secure, httpOnly: true }),
        setCookie(HINT_COOKIE, '1', SESSION_S, { secure, httpOnly: false }),
      ];
    },
    upsertByEmail: (email) => s.byEmail.get(email) ?? create(email),
    upsertGithub(user) {
      const account = s.byGithub.get(user.id) ?? s.byEmail.get(user.email) ?? create(user.email);
      // An account linked to a different GitHub user is never handed to this one, even when the
      // email now matches (a reassigned mailbox): its tunnels and plan would go with it.
      if (account.github_id !== null && account.github_id !== user.id) return undefined;
      s.setGithub.run(user.id, user.login, account.id);
      return s.byId.get(account.id)!;
    },
    isAdmin: (account) => features.adminEmails.has(account.email),
  };

  app.on('GET', '/v1/auth/methods', async (_req, res) =>
    send(res, 200, { github: Boolean(features.github), email: Boolean(features.email), billing: Boolean(features.billing) }),
  );

  app.on('POST', '/v1/auth/logout', async (req, res) => {
    accounts.requireOrigin(req);
    const token = cookies(req)[SESSION_COOKIE];
    if (token) s.deleteSession.run(sha256(token));
    send(res, 204, undefined, {
      'set-cookie': [
        setCookie(SESSION_COOKIE, '', 0, { secure, httpOnly: true }),
        setCookie(HINT_COOKIE, '', 0, { secure, httpOnly: false }),
      ],
    });
  });

  app.on('GET', '/v1/account', async (req, res) => {
    const account = accounts.requireSession(req);
    send(res, 200, {
      email: account.email,
      githubLogin: account.github_login,
      plan: account.plan,
      planSource: account.plan_source,
      planUntil: account.plan_until,
      limits: app.plans.limitsOf(account.plan),
      usage: { tunnels: app.plans.accountTunnels(account.id), storageBytes: app.plans.storedBytes(account.id) },
      devices: s.devices.all(account.id),
      subscription: app.billing?.subscriptionOf(account.id) ?? null,
      admin: accounts.isAdmin(account),
    });
  });

  app.on('POST', '/v1/account/devices/:id/unlink', async (req, res, [id]) => {
    accounts.requireOrigin(req);
    const account = accounts.requireSession(req);
    if (Number(s.unlink.run(id, account.id).changes) === 0) {
      throw new HttpError(404, "That machine isn't linked to your account.");
    }
    send(res, 204);
  });

  app.sweeps.push(() => {
    const now = Date.now();
    for (const stmt of s.expired) stmt.run(now);
  });

  return accounts;
}

// ---------- linking machines (tunnel login) ----------

/** No 0/O, 1/I/L or U, so a code read aloud or retyped comes out the same. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LINK_S = 10 * 60;

/** A code as stored: upper case, letters and digits only. */
export const normalizeCode = (value: unknown) =>
  typeof value === 'string' ? value.toUpperCase().replace(/[^0-9A-Z]/g, '') : '';

/** A stored code as people see it: ABCD-EFGH. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const newUserCode = () =>
  Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/**
 * The device-code flow behind `tunnel login`. The CLI asks for a code, the person confirms it on
 * the account page (which links the machine there and then), and the CLI's poll reports the result.
 */
export function linkRoutes(app: App, accounts: Accounts) {
  const { store } = app;
  const publicUrl = app.features.publicUrl!;
  const s = {
    insert: store.prepare('INSERT INTO device_links (user_code, poll_hash, device_id, expires) VALUES (?, ?, ?, ?)'),
    poll: store.prepare<{ account_id: string | null }>(
      'SELECT account_id FROM device_links WHERE poll_hash = ? AND expires > ?',
    ),
    drop: store.prepare('DELETE FROM device_links WHERE poll_hash = ?'),
    approve: store.prepare<{ device_id: string }>(
      `UPDATE device_links SET account_id = ?
        WHERE user_code = ? AND expires > ? AND account_id IS NULL
        RETURNING device_id`,
    ),
    link: store.prepare('UPDATE devices SET account_id = ? WHERE id = ?'),
    unlink: store.prepare('UPDATE devices SET account_id = NULL WHERE id = ?'),
  };
  const limitStarts = app.counter(
    10 * 60_000,
    10,
    'Too many login requests from this machine. Wait ten minutes and try again.',
  );
  // 30^8 codes live for 10 minutes; 20 tries per account per 10 minutes makes guessing hopeless.
  const limitLinks = app.counter(10 * 60_000, 20, 'Too many link attempts. Wait ten minutes and try again.');

  app.on('POST', '/v1/auth/device', async (req, res) => {
    const device = app.device(req);
    limitStarts(req, device.id);
    const userCode = newUserCode();
    const pollToken = secretToken();
    s.insert.run(userCode, sha256(pollToken), device.id, Date.now() + LINK_S * 1000);
    send(res, 201, {
      userCode: formatCode(userCode),
      verifyUrl: `${publicUrl}/account?link=${formatCode(userCode)}`,
      pollToken,
      expiresIn: LINK_S,
      interval: app.linkPollSeconds,
    });
  });

  app.on('POST', '/v1/auth/device/poll', async (req, res) => {
    const input = await json<{ pollToken?: unknown }>(req);
    const hash = sha256(typeof input.pollToken === 'string' ? input.pollToken : '');
    const link = s.poll.get(hash, Date.now());
    if (!link) throw new HttpError(410, 'This login request expired. Run `tunnel login` again.');
    if (!link.account_id) return send(res, 202, { status: 'pending' });
    s.drop.run(hash);
    const account = accounts.byId(link.account_id);
    send(res, 200, { email: account?.email ?? null, plan: account?.plan ?? 'free' });
  });

  app.on('POST', '/v1/account/devices/link', async (req, res) => {
    accounts.requireOrigin(req);
    const account = accounts.requireSession(req);
    limitLinks(req, account.id);
    const input = await json<{ userCode?: unknown }>(req);
    const row = s.approve.get(account.id, normalizeCode(input.userCode), Date.now());
    if (!row) throw new HttpError(404, 'That code is wrong or has expired. Run `tunnel login` again for a new one.');
    s.link.run(account.id, row.device_id);
    send(res, 204);
  });

  app.on('GET', '/v1/devices/me', async (req, res) => {
    const device = app.device(req);
    const account = device.account_id ? accounts.byId(device.account_id) : undefined;
    const tunnels = app.plans.tunnelsOf(device);
    send(res, 200, {
      deviceId: device.id,
      account: account ? { email: account.email } : null,
      plan: tunnels.plan,
      limits: app.plans.limitsOf(tunnels.plan),
      usage: { tunnels: tunnels.used, storageBytes: account ? app.plans.storedBytes(account.id) : 0 },
    });
  });

  app.on('POST', '/v1/devices/me/unlink', async (req, res) => {
    const device = app.device(req);
    const account = device.account_id ? accounts.byId(device.account_id) : undefined;
    s.unlink.run(device.id);
    send(res, 200, { email: account?.email ?? null });
  });
}
