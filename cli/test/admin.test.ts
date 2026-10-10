import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf } from '../src/relay/stats.js';
import {
  ADMIN,
  DAY,
  FULL_ENV,
  accountIdOf,
  agent,
  browser,
  outbound,
  relay,
  signIn,
  sql,
  type Browser,
  type TestRelay,
} from './helpers.js';

describe('admin', () => {
  const out = outbound();
  const logs: string[] = [];
  let r: TestRelay;
  let boss: Browser;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch, maxTunnelsPerDevice: 1, log: (line) => logs.push(line) });
    boss = browser(r);
    await signIn(boss, out, ADMIN);
  });
  after(() => r.close());

  const grant = (b: Browser, id: string, data: unknown) => b.post(`/v1/admin/accounts/${id}/plan`, data);

  test('admin routes look like they do not exist to everyone else', async () => {
    const anonymous = browser(r);
    const user = browser(r);
    await signIn(user, out, 'outsider@example.com');
    const id = await accountIdOf(r.dataDir, 'outsider@example.com');
    for (const b of [anonymous, user]) {
      for (const res of [
        await b.get('/v1/admin/stats'),
        await b.get('/v1/admin/accounts'),
        await grant(b, id, { plan: 'pro' }),
        // A bad escape in the id is no different: no 500 that would show admin is switched on.
        await grant(b, '%zz', { plan: 'pro' }),
      ]) {
        assert.equal(res.status, 404);
        assert.deepEqual(res.body, { error: 'Not found.' });
      }
    }
    assert.equal((await user.get('/v1/account')).body.plan, 'free');
    // Not even the admin gets anything but the plain 404 for it.
    const bad = await grant(boss, '%zz', { plan: 'pro' });
    assert.equal(bad.status, 404);
    assert.deepEqual(bad.body, { error: 'Not found.' });
  });

  test('stats: daily series, active agents and machines, plans, revenue and referrers', async () => {
    const a = agent(() => r, 'stats');
    assert.equal((await a.run('open', 'c')).code, 0);
    assert.equal((await a.run('send', 'hello')).code, 0);
    await sql(
      r.dataDir,
      "INSERT INTO stats_daily (day, metric, n) VALUES (?, 'messages', 7)",
      dayOf(Date.now() - 2 * DAY),
    );
    await sql(r.dataDir, "INSERT INTO referrers (day, host, n) VALUES (?, 'news.ycombinator.com', 3)", dayOf());
    const now = Date.now();
    await sql(
      r.dataDir,
      `INSERT INTO accounts (id, email, plan, plan_source, created, seen) VALUES
         ('a_payer', 'payer@example.com', 'plus', 'billing', ?1, ?1),
         ('a_gift', 'gift@example.com', 'pro', 'admin', ?1, ?1)`,
      now,
    );

    const res = await boss.get('/v1/admin/stats');
    assert.equal(res.status, 200);
    const stats = res.body;
    assert.equal(stats.days.length, 30);
    assert.equal(stats.days.at(-1), dayOf());
    assert.equal(stats.series.messages.length, 30);
    assert.equal(stats.series.messages.at(-3), 7);
    assert.equal(stats.series.messages.at(-1), 1);
    assert.equal(stats.series.messages.at(-2), 0);
    assert.equal(stats.today.messages, 1);
    assert.equal(stats.today.tunnels_opened, 1);
    assert.equal(stats.series.active_devices.at(-1), 1);
    assert.equal(stats.series.active_members.at(-1), 1);
    assert.deepEqual(stats.active.devices, { d1: 1, d7: 1, d30: 1 });
    assert.deepEqual(stats.active.agents, { d1: 1, d7: 1, d30: 1 });
    assert.ok(stats.active.accounts.d1 >= 1, 'the signed-in admin is active');
    assert.equal(stats.plans.plus, 1);
    assert.equal(stats.plans.pro, 1);
    assert.equal(stats.mrr, 5); // the gift is not revenue
    assert.deepEqual(stats.referrers, [{ host: 'news.ycombinator.com', n: 3 }]);

    assert.equal((await boss.get('/v1/admin/stats?days=500')).body.days.length, 90);
    assert.equal((await boss.get('/v1/admin/stats?days=nonsense')).body.days.length, 30);
    assert.equal((await boss.get('/v1/admin/stats?days=')).body.days.length, 30);
    // A number is clamped, not mistaken for a missing value.
    assert.equal((await boss.get('/v1/admin/stats?days=0')).body.days.length, 1);
    assert.equal((await boss.get('/v1/admin/stats?days=-7')).body.days.length, 1);
    assert.equal((await boss.get('/v1/admin/stats?days=7')).body.days.length, 7);
  });

  test('accounts: search, newest first, 50 to a page', async () => {
    await sql(
      r.dataDir,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 55)
       INSERT INTO accounts (id, email, created, seen) SELECT 'a_bulk' || i, 'bulk' || i || '@example.com', i, i FROM n`,
    );
    const first = (await boss.get('/v1/admin/accounts?q=bulk')).body;
    assert.equal(first.accounts.length, 50);
    assert.equal(first.next, '50');
    assert.equal(first.accounts[0].email, 'bulk55@example.com');
    assert.deepEqual(Object.keys(first.accounts[0]).sort(), [
      'created',
      'devices',
      'email',
      'githubLogin',
      'id',
      'plan',
      'planSource',
      'planUntil',
      'seen',
      'tunnels',
    ]);
    const second = (await boss.get(`/v1/admin/accounts?q=bulk&cursor=${first.next}`)).body;
    assert.equal(second.accounts.length, 5);
    assert.equal(second.next, null);
    assert.equal(second.accounts.at(-1).email, 'bulk1@example.com');

    assert.equal((await boss.get('/v1/admin/accounts?q=BULK1')).body.accounts.length, 11); // bulk1, bulk10–19
    assert.equal((await boss.get('/v1/admin/accounts?q=%25')).body.accounts.length, 0); // "%" is literal
    assert.ok((await boss.get('/v1/admin/accounts')).body.accounts.length > 0);
  });

  test('grants: give a plan with an end date, clear it, and refuse bad input', async () => {
    const user = browser(r);
    await signIn(user, out, 'friend@example.com');
    const id = await accountIdOf(r.dataDir, 'friend@example.com');
    const bossId = await accountIdOf(r.dataDir, ADMIN);
    const until = Date.now() + 7 * DAY;
    const audit = () => logs.filter((line) => line.startsWith('Admin '));

    const given = await grant(boss, id, { plan: 'pro', until });
    assert.equal(given.status, 200);
    assert.deepEqual(given.body, { plan: 'pro', planSource: 'admin', planUntil: until });
    assert.equal((await user.get('/v1/account')).body.limits.tunnels, 20);
    assert.deepEqual(audit(), [
      `Admin ${bossId} gave account ${id} the pro plan until ${new Date(until).toISOString()}.`,
    ]);

    const cleared = await grant(boss, id, { plan: null });
    assert.deepEqual(cleared.body, { plan: 'free', planSource: null, planUntil: null });
    assert.equal(audit().length, 2);
    assert.equal(audit()[1], `Admin ${bossId} cleared the plan grant on account ${id}.`);

    const gold = await grant(boss, id, { plan: 'gold' });
    assert.equal(gold.status, 400);
    assert.equal(gold.body.error, 'Plan must be free, plus, pro or null.');
    const past = await grant(boss, id, { plan: 'plus', until: Date.now() - 1000 });
    assert.equal(past.status, 400);
    assert.equal(past.body.error, 'The end date must be in the future.');
    const nobody = await grant(boss, 'a_nobody', { plan: 'plus' });
    assert.equal(nobody.status, 404);
    assert.equal(nobody.body.error, 'No account with that id.');

    // Only changes are logged, and never an email address.
    assert.equal(audit().length, 2);
    assert.ok(!logs.some((line) => line.includes('@')), 'no email address in the log');
    const forever = await grant(boss, id, { plan: 'plus' });
    assert.equal(forever.status, 200);
    assert.equal(audit().at(-1), `Admin ${bossId} gave account ${id} the plus plan until no end.`);
    await grant(boss, id, { plan: null });
  });

  test('a grant from another site is blocked, even with the admin cookie', async () => {
    const id = await accountIdOf(r.dataDir, 'outsider@example.com');
    const evil = browser(r, 'https://evil.example');
    for (const [name, value] of boss.jar) evil.jar.set(name, value);
    const res = await grant(evil, id, { plan: 'pro' });
    assert.equal(res.status, 403);
    assert.equal((await sql(r.dataDir, 'SELECT plan FROM accounts WHERE id = ?', id))[0].plan, 'free');
  });

  test('a grant that runs out ends at the next sweep', async () => {
    const user = browser(r);
    await signIn(user, out, 'trial@example.com');
    const id = await accountIdOf(r.dataDir, 'trial@example.com');
    assert.equal((await grant(boss, id, { plan: 'plus', until: Date.now() + DAY })).status, 200);
    await sql(r.dataDir, 'UPDATE accounts SET plan_until = ? WHERE id = ?', Date.now() - 1000, id);
    await r.sweep();
    const me = (await user.get('/v1/account')).body;
    assert.equal(me.plan, 'free');
    assert.equal(me.planSource, null);
  });

  test('odd cursors and end dates are refused or ignored, never a 500', async () => {
    for (const cursor of ['1e308', 'Infinity', '-5', '2.5', 'abc', '']) {
      const res = await boss.get(`/v1/admin/accounts?cursor=${cursor}`);
      assert.equal(res.status, 200, cursor);
    }
    const id = await accountIdOf(r.dataDir, 'friend@example.com');
    for (const until of [1e308, 8.7e15, 'tomorrow', Date.now() + 1.5, true]) {
      const res = await grant(boss, id, { plan: 'plus', until });
      assert.equal(res.status, 400, String(until));
      assert.equal(res.body.error, 'The end date must be in the future.');
    }
    assert.equal((await sql(r.dataDir, 'SELECT plan_source FROM accounts WHERE id = ?', id))[0].plan_source, null);
  });
});

// Billing is optional, but admin grants must work and end on a relay that has none.
describe('admin without billing', () => {
  const out = outbound();
  let r: TestRelay;
  let boss: Browser;
  before(async () => {
    const env = Object.fromEntries(Object.entries(FULL_ENV).filter(([name]) => !name.startsWith('LEMONSQUEEZY_')));
    r = await relay({ env, fetch: out.fetch });
    boss = browser(r);
    await signIn(boss, out, ADMIN);
  });
  after(() => r.close());

  test('a grant gives the plan, and ends at the sweep once its date has passed', async () => {
    const user = browser(r);
    await signIn(user, out, 'guest@example.com');
    const id = await accountIdOf(r.dataDir, 'guest@example.com');
    const given = await boss.post(`/v1/admin/accounts/${id}/plan`, { plan: 'plus', until: Date.now() + DAY });
    assert.equal(given.status, 200);
    assert.equal((await user.get('/v1/account')).body.plan, 'plus');
    assert.equal((await boss.get('/v1/admin/stats')).body.mrr, 0);

    await sql(r.dataDir, 'UPDATE accounts SET plan_until = ? WHERE id = ?', Date.now() - 1000, id);
    await r.sweep();
    const me = (await user.get('/v1/account')).body;
    assert.equal(me.plan, 'free');
    assert.equal(me.planSource, null);
  });
});
