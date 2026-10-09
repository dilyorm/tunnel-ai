import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { openStore } from '../src/relay/db.js';
import { startRelay, type Relay, type RelayOptions } from '../src/relay/server.js';
import type { TunnelRecord } from '../src/store.js';

// Shared by the account, billing, stats and admin suites. tunnel.test.ts keeps its own copies so the
// original suite runs unchanged.

export const tmp = (label: string) => mkdtempSync(join(tmpdir(), `tunnel-${label}-`));
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const DAY = 24 * 60 * 60 * 1000;
export const PUBLIC_URL = 'http://tunnel.test';
export const ADMIN = 'boss@example.com';

/** Every feature switched on against fake services. Pair it with `fetch: outbound().fetch`. */
export const FULL_ENV: Record<string, string> = {
  TUNNEL_PUBLIC_URL: PUBLIC_URL,
  GITHUB_CLIENT_ID: 'gh-id',
  GITHUB_CLIENT_SECRET: 'gh-secret',
  RESEND_API_KEY: 're_test',
  TUNNEL_EMAIL_FROM: 'tunnel <login@tunnel.test>',
  LEMONSQUEEZY_API_KEY: 'ls_test',
  LEMONSQUEEZY_STORE_ID: '11',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'whsec',
  LEMONSQUEEZY_VARIANT_PLUS: '101',
  LEMONSQUEEZY_VARIANT_PRO: '102',
  TUNNEL_ADMIN_EMAILS: ADMIN,
  TUNNEL_STATS_SALT: 'salt',
};

export interface TestRelay extends Relay {
  dataDir: string;
}

export async function relay(options: Partial<RelayOptions> = {}): Promise<TestRelay> {
  const dataDir = options.dataDir ?? tmp('relay');
  const started = await startRelay({ port: 0, host: '127.0.0.1', log: () => {}, ...options, dataDir });
  return Object.assign(started, { dataDir });
}

export type Agent = ReturnType<typeof agent>;

/** One machine running the CLI against a relay, with its own ~/.tunnel. */
export function agent(relayOf: () => { url: string }, label: string) {
  const home = tmp(label);
  const cwd = tmp(`${label}-cwd`);
  const opened: string[] = [];
  const read = <T>(file: string) => JSON.parse(readFileSync(join(home, file), 'utf8')) as T;
  return {
    home,
    cwd,
    /** Links the CLI asked to open in a browser, oldest first. */
    opened,
    async run(...argv: string[]) {
      let out = '';
      let err = '';
      const code = await run(argv, {
        env: { TUNNEL_HOME: home, TUNNEL_RELAY: relayOf().url },
        cwd,
        out: (s) => (out += s + '\n'),
        err: (s) => (err += s + '\n'),
        openUrl: (url) => opened.push(url),
      });
      return { code, out, err };
    },
    deviceId: () => read<{ devices: Record<string, { id: string }> }>('config.json').devices[relayOf().url].id,
    tunnel: (name: string) => read<Record<string, TunnelRecord>>('tunnels.json')[name],
  };
}

/** One statement against a relay's database, through a second connection. Rows come back as plain objects. */
export async function sql(dataDir: string, statement: string, ...params: (string | number | null)[]): Promise<any[]> {
  const store = await openStore(dataDir);
  try {
    return store.db.prepare(statement).all(...params).map((row) => ({ ...row }));
  } finally {
    store.close();
  }
}

/** Put these devices on one new account with `plan`, as an admin grant (billing leaves it alone). Returns the account id. */
export async function grant(dataDir: string, plan: 'free' | 'plus' | 'pro', ...deviceIds: string[]): Promise<string> {
  const store = await openStore(dataDir);
  try {
    const id = `a_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    store.db
      .prepare("INSERT INTO accounts (id, email, plan, plan_source, created, seen) VALUES (?, ?, ?, 'admin', ?, ?)")
      .run(id, `${id}@example.com`, plan, now, now);
    for (const device of deviceIds) store.db.prepare('UPDATE devices SET account_id = ? WHERE id = ?').run(id, device);
    return id;
  } finally {
    store.close();
  }
}

export type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
export type Outbound = ReturnType<typeof outbound>;

/**
 * Stands in for GitHub, Resend and Lemon Squeezy. A request goes to the route with the longest
 * matching URL prefix; anything unmatched gets a 599. Tests may swap entries in `table`.
 */
export function outbound(routes: Record<string, Route> = {}) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const table: Record<string, Route> = {
    'https://api.resend.com/emails': () => Response.json({ id: 'email_1' }),
    ...routes,
  };
  const stub = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    let body: any = init.body;
    try {
      body = JSON.parse(String(init.body));
    } catch {
      // not JSON; keep it as sent
    }
    calls.push({ url, init, body });
    const prefix = Object.keys(table)
      .filter((p) => url.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ? table[prefix](url, init) : new Response(`no stub for ${url}`, { status: 599 });
  }) as typeof fetch;
  return {
    fetch: stub,
    calls,
    table,
    /** The sign-in link in the newest email. */
    lastLink(): string {
      const mail = calls.filter((c) => c.url === 'https://api.resend.com/emails').at(-1);
      const match = /https?:\/\/\S+/.exec(mail?.body?.text ?? '');
      if (!match) throw new Error('No sign-in email was sent.');
      return match[0];
    },
  };
}

export interface Page {
  status: number;
  headers: Headers;
  body: any;
}

export type Browser = ReturnType<typeof browser>;

/**
 * A browser on `origin`: keeps cookies, sends Origin on POSTs, and does not follow redirects.
 * `extra` adds request headers. A page's own fetch of a GET route that checks the request's origin
 * (Manage billing) carries `sec-fetch-site: same-origin`, so tests for such a route pass it here.
 */
export function browser(r: { url: string }, origin = PUBLIC_URL) {
  const jar = new Map<string, string>();
  async function request(method: string, path: string, data?: unknown, extra: Record<string, string> = {}): Promise<Page> {
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') headers.origin = origin;
    if (data !== undefined) headers['content-type'] = 'application/json';
    Object.assign(headers, extra);
    const res = await fetch(r.url + path, {
      method,
      headers,
      redirect: 'manual',
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      if (attributes.some((a) => a.trim() === 'Max-Age=0')) jar.delete(name);
      else jar.set(name, pair.slice(i + 1));
    }
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, body };
  }
  return {
    jar,
    request,
    get: (path: string, extra?: Record<string, string>) => request('GET', path, undefined, extra),
    post: (path: string, data: unknown = {}) => request('POST', path, data),
  };
}

/**
 * Open an emailed sign-in link in this browser, as the account page does. A browser that didn't ask
 * for the link is told to confirm (409); pass `confirm` to answer yes.
 */
export async function follow(b: Browser, link: string, confirm = false): Promise<Page> {
  const url = new URL(link);
  const landing = await b.get(url.pathname + url.search);
  const token = new URL(landing.headers.get('location') ?? '/', PUBLIC_URL).searchParams.get('login');
  return b.post('/v1/auth/email/verify', confirm ? { token, confirm: true } : { token });
}

/** Sign in by email. Returns the path the account page should go to next. */
export async function signIn(b: Browser, out: Outbound, email: string, returnTo?: string): Promise<string> {
  const ask = await b.post('/v1/auth/email', { email, return: returnTo });
  assert.equal(ask.status, 202, JSON.stringify(ask.body));
  const done = await follow(b, out.lastLink());
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.returnTo;
}

/** Poll until `fn` returns something truthy. */
export async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Nothing after ${ms} ms.`);
    await sleep(10);
  }
}

/**
 * Run `tunnel login` on `a` and confirm its code in browser `b`, as a person would.
 * Use a relay started with a small `linkPollSeconds`. Returns the finished login run.
 */
export async function linkMachine(a: Agent, b: Browser, ...flags: string[]) {
  const before = a.opened.length;
  const login = a.run('login', ...flags);
  const url = await until(() => a.opened[before]);
  const userCode = new URL(url).searchParams.get('link');
  const res = await b.post('/v1/account/devices/link', { userCode });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  return login;
}

export async function accountIdOf(dataDir: string, email: string): Promise<string> {
  const [row] = await sql(dataDir, 'SELECT id FROM accounts WHERE email = ?', email);
  if (!row) throw new Error(`No account for ${email}.`);
  return row.id;
}
