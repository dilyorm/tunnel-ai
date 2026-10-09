import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { lemonSqueezy } from '../src/relay/billing/lemonsqueezy.js';
import {
  DAY,
  FULL_ENV,
  PUBLIC_URL,
  accountIdOf,
  agent,
  browser,
  linkMachine,
  outbound,
  relay,
  signIn,
  sql,
  type Browser,
  type Route,
  type TestRelay,
} from './helpers.js';

const CHECKOUTS = 'https://api.lemonsqueezy.com/v1/checkouts';
const SUBSCRIPTIONS = 'https://api.lemonsqueezy.com/v1/subscriptions/';

const TABLE =
  'Plus  $5/month  10 tunnels, files up to 50 MB, 30 days of history, 2 GB of storage\n' +
  'Pro   $9/month  20 tunnels, files up to 100 MB, 30 days of history, 5 GB of storage\n';
const BUDGET = 'Too many billing requests. Wait ten minutes and try again.';
const ANOTHER_SITE = 'This request came from another site, so it was blocked.';

/** What the account page's own fetch carries. The portal route refuses a GET that doesn't. */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };
const portal = (b: Browser, headers: Record<string, string> = SAME_ORIGIN) => b.get('/v1/account/portal', headers);

// Lemon Squeezy's clock: each event built here is one minute newer than the one before.
let clock = Date.parse('2026-10-01T00:00:00Z');
const tick = () => new Date((clock += 60_000)).toISOString();

/** A subscription webhook body as Lemon Squeezy sends it. Variant 101 is Plus and 102 Pro in FULL_ENV. */
function lemon(event: string, accountId: string, attributes: Record<string, unknown> = {}, id = 'sub_1') {
  return JSON.stringify({
    meta: { event_name: event, custom_data: { account_id: accountId } },
    data: {
      type: 'subscriptions',
      id,
      attributes: {
        variant_id: 102,
        status: 'active',
        renews_at: '2026-11-09T00:00:00.000000Z',
        ends_at: null,
        updated_at: tick(),
        ...attributes,
      },
    },
  });
}

describe('billing', () => {
  const lines: string[] = [];
  const out = outbound({
    [CHECKOUTS]: () => Response.json({ data: { attributes: { url: 'https://pay.example/checkout/abc' } } }),
    [SUBSCRIPTIONS]: (url) =>
      Response.json({
        data: { attributes: { urls: { customer_portal: `https://pay.example/portal/${url.split('/').pop()}` } } },
      }),
  });
  let r: TestRelay;
  before(async () => {
    r = await relay({
      env: FULL_ENV,
      fetch: out.fetch,
      log: (line) => lines.push(line),
      linkPollSeconds: 0.05,
      maxTunnelsPerDevice: 1,
    });
  });
  after(() => r.close());

  const deliver = (raw: string, secret = 'whsec', url = r.url) =>
    fetch(`${url}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      },
      body: raw,
    });

  /** A signed-in browser and its account id. */
  async function customer(email: string): Promise<[Browser, string]> {
    const b = browser(r);
    await signIn(b, out, email);
    return [b, await accountIdOf(r.dataDir, email)];
  }

  const planOf = async (b: Browser) => (await b.get('/v1/account')).body.plan;
  const logged = (line: string) => assert.ok(lines.includes(line), `missing "${line}" in:\n${lines.join('\n')}`);

  test('checkout opens a Lemon Squeezy page for the signed-in account', async () => {
    const [b, id] = await customer('buyer@example.com');
    const res = await b.post('/v1/account/checkout', { plan: 'pro' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { url: 'https://pay.example/checkout/abc' });
    const call = out.calls.filter((c) => c.url === CHECKOUTS).at(-1)!;
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer ls_test');
    const { attributes, relationships } = call.body.data;
    assert.deepEqual(attributes.checkout_data, { email: 'buyer@example.com', custom: { account_id: id } });
    assert.equal(attributes.product_options.redirect_url, `${PUBLIC_URL}/account?upgraded=1`);
    assert.equal(relationships.store.data.id, '11');
    assert.equal(relationships.variant.data.id, '102');

    const bad = await b.post('/v1/account/checkout', { plan: 'gold' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Pick a plan: plus or pro.');
  });

  test('a signed webhook moves the account to Pro and raises its limits', async () => {
    const [b, id] = await customer('paid@example.com');
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_paid'))).status, 200);
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'pro');
    assert.equal(me.planSource, 'billing');
    assert.equal(me.limits.fileBytes, 100 * 1024 * 1024);
    assert.deepEqual(me.subscription, {
      plan: 'pro',
      status: 'active',
      renewsAt: Date.parse('2026-11-09T00:00:00Z'),
      endsAt: null,
    });
    logged(`Billing subscription_created (active) for ${id}: applied.`);
  });

  test('a bad signature is refused and changes nothing', async () => {
    const [b, id] = await customer('forged@example.com');
    const res = await deliver(lemon('subscription_created', id, {}, 'sub_forged'), 'not-the-secret');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Bad signature.' });
    assert.equal(await planOf(b), 'free');
  });

  test('a repeated delivery is applied once', async () => {
    const [, id] = await customer('twice@example.com');
    const raw = lemon('subscription_created', id, {}, 'sub_twice');
    const count = async () => (await sql(r.dataDir, 'SELECT COUNT(*) AS n FROM billing_events'))[0].n;
    const before = await count();
    assert.equal((await deliver(raw)).status, 200);
    assert.equal((await deliver(raw)).status, 200);
    assert.equal(await count(), before + 1);
    logged(`Billing subscription_created (active) for ${id}: duplicate, skipped.`);
  });

  test('an older event arriving late does not undo a newer one', async () => {
    const [b, id] = await customer('late@example.com');
    const older = lemon('subscription_expired', id, { status: 'expired', ends_at: '2026-10-01T00:00:00.000000Z' }, 'sub_late');
    const newer = lemon('subscription_resumed', id, { status: 'active' }, 'sub_late');
    assert.equal((await deliver(newer)).status, 200);
    assert.equal((await deliver(older)).status, 200);
    assert.equal(await planOf(b), 'pro');
    logged(`Billing subscription_expired (expired) for ${id}: older than what we have, skipped.`);
  });

  test('a cancelled plan lasts until its end date, then the sweep returns it to Free', async () => {
    const [b, id] = await customer('leaving@example.com');
    const endsAt = new Date(Date.now() + 3 * DAY).toISOString();
    const cancelled = lemon('subscription_cancelled', id, { status: 'cancelled', ends_at: endsAt }, 'sub_leaving');
    assert.equal((await deliver(cancelled)).status, 200);
    assert.equal(await planOf(b), 'pro');

    await sql(r.dataDir, "UPDATE subscriptions SET ends_at = ? WHERE provider_id = 'sub_leaving'", Date.now() - 1000);
    await r.sweep();
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'free');
    assert.equal(me.planSource, null);
    assert.equal(me.subscription, null);
  });

  test('a Plus or Pro customer cannot open a second subscription', async () => {
    const [b, id] = await customer('plus@example.com');
    assert.equal((await deliver(lemon('subscription_created', id, { variant_id: 101 }, 'sub_plus'))).status, 200);
    assert.equal(await planOf(b), 'plus');

    const checkouts = () => out.calls.filter((c) => c.url === CHECKOUTS).length;
    const before = checkouts();
    const again = await b.post('/v1/account/checkout', { plan: 'pro' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'You already have a subscription. Change plans from Manage billing on your account page.');
    assert.equal(checkouts(), before);

    const a = agent(() => r, 'plus-cli');
    assert.equal((await linkMachine(a, b)).code, 0);
    const cli = await a.run('upgrade', 'pro');
    assert.equal(cli.code, 1);
    assert.match(cli.err, /^You already have a subscription\./);
    assert.equal(checkouts(), before);
  });

  test('Manage billing fetches a fresh portal link for the newest subscription', async () => {
    const [b, id] = await customer('portal@example.com');
    const none = await portal(b);
    assert.equal(none.status, 404);
    assert.equal(none.body.error, 'No subscription yet.');
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_portal'))).status, 200);
    assert.deepEqual((await portal(b)).body, { url: 'https://pay.example/portal/sub_portal' });
  });

  test('other products, unknown accounts and other events are ignored', async () => {
    const [b, id] = await customer('other@example.com');
    assert.equal((await deliver(lemon('subscription_created', id, { variant_id: 999 }, 'sub_other'))).status, 200);
    assert.equal((await deliver(lemon('subscription_created', 'a_nobody', {}, 'sub_ghost'))).status, 200);
    assert.equal((await deliver(JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } }))).status, 200);
    assert.equal(await planOf(b), 'free');
    logged(`Billing subscription_created (active) for ${id}: not a tunnel plan, skipped.`);
    logged('Billing subscription_created (active) for a_nobody: unknown account, skipped.');
  });

  test('an admin grant wins over billing until it ends', async () => {
    const [b, id] = await customer('granted@example.com');
    await sql(
      r.dataDir,
      "UPDATE accounts SET plan = 'pro', plan_source = 'admin', plan_until = ? WHERE id = ?",
      Date.now() + DAY,
      id,
    );
    assert.equal((await deliver(lemon('subscription_created', id, { variant_id: 101 }, 'sub_granted'))).status, 200);
    assert.equal(await planOf(b), 'pro');

    await sql(r.dataDir, 'UPDATE accounts SET plan_until = ? WHERE id = ?', Date.now() - 1000, id);
    await r.sweep();
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'plus');
    assert.equal(me.planSource, 'billing');
  });

  test('tunnel upgrade prints both prices, or opens checkout for a linked machine', async () => {
    const a = agent(() => r, 'upgrade');
    assert.equal((await a.run('upgrade')).out, TABLE + 'Run `tunnel upgrade plus` or `tunnel upgrade pro` to pay.\n');
    assert.equal(JSON.parse((await a.run('upgrade', '--json')).out).billing, true);
    assert.equal((await a.run('upgrade', 'gold')).code, 2);
    const unlinked = await a.run('upgrade', 'plus');
    assert.equal(unlinked.code, 1);
    assert.equal(unlinked.err, "This machine isn't linked to an account. Run `tunnel login` first.\n");

    const [b] = await customer('cli@example.com');
    assert.equal((await linkMachine(a, b)).code, 0);
    const paid = await a.run('upgrade', 'plus');
    assert.equal(paid.code, 0, paid.err);
    assert.equal(paid.out, 'Open this page to pay for Plus:\nhttps://pay.example/checkout/abc\n');
    assert.equal(a.opened.at(-1), 'https://pay.example/checkout/abc');
  });

  test('when Lemon Squeezy is down, checkout says so', async () => {
    const [b] = await customer('down@example.com');
    const checkouts = out.table[CHECKOUTS];
    out.table[CHECKOUTS] = () => new Response('', { status: 500 });
    try {
      const res = await b.post('/v1/account/checkout', { plan: 'plus' });
      assert.equal(res.status, 502);
      assert.equal(res.body.error, "The payment page didn't load. Try again in a minute.");
    } finally {
      out.table[CHECKOUTS] = checkouts;
    }
  });

  /** Answer `url` with `route` while `fn` runs. */
  async function answering<T>(url: string, route: Route, fn: () => Promise<T>): Promise<T> {
    const saved = out.table[url];
    out.table[url] = route;
    try {
      return await fn();
    } finally {
      out.table[url] = saved;
    }
  }

  test('an event skipped for a setup mistake applies when the provider resends it after the fix', async () => {
    const open: TestRelay[] = [];
    try {
      const first = await relay({ env: FULL_ENV, fetch: out.fetch, log: (line) => lines.push(line) });
      open.push(first);
      const target = { url: first.url };
      const b = browser(target);
      await signIn(b, out, 'golive@example.com');
      const id = await accountIdOf(first.dataDir, 'golive@example.com');
      // Variant 777 is not one of our plans yet: the owner left the wrong ids in the environment.
      const raw = lemon('subscription_created', id, { variant_id: 777 }, 'sub_golive');
      const remembered = async () => (await sql(first.dataDir, 'SELECT COUNT(*) AS n FROM billing_events'))[0].n;
      const before = await remembered();
      assert.equal((await deliver(raw, 'whsec', first.url)).status, 200);
      assert.equal(await remembered(), before);
      assert.equal(await planOf(b), 'free');
      logged(`Billing subscription_created (active) for ${id}: not a tunnel plan, skipped.`);
      await first.close();
      open.pop();

      const second = await relay({
        dataDir: first.dataDir,
        env: { ...FULL_ENV, LEMONSQUEEZY_VARIANT_PLUS: '777' },
        fetch: out.fetch,
        log: (line) => lines.push(line),
      });
      open.push(second);
      target.url = second.url;
      assert.equal((await deliver(raw, 'whsec', second.url)).status, 200);
      assert.equal(await planOf(b), 'plus');
      logged(`Billing subscription_created (active) for ${id}: applied.`);
    } finally {
      for (const each of open) await each.close();
    }
  });

  test('a subscription that moves to a product we do not sell stops giving a plan', async () => {
    const [b, id] = await customer('switched@example.com');
    // Built before the create, so it is the older of the two.
    const stale = lemon('subscription_updated', id, { variant_id: 999 }, 'sub_switch');
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_switch'))).status, 200);
    assert.equal(await planOf(b), 'pro');
    assert.equal((await deliver(stale)).status, 200);
    assert.equal(await planOf(b), 'pro');
    logged(`Billing subscription_updated (active) for ${id}: older than what we have, skipped.`);

    const moved = lemon('subscription_updated', id, { variant_id: 999 }, 'sub_switch');
    assert.equal((await deliver(moved)).status, 200);
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'free');
    assert.equal(me.planSource, null);
    assert.equal(me.subscription, null);
    logged(`Billing subscription_updated (active) for ${id}: not a tunnel plan, subscription ended.`);
    const [row] = await sql(r.dataDir, "SELECT plan, active FROM subscriptions WHERE provider_id = 'sub_switch'");
    assert.deepEqual({ ...row }, { plan: 'pro', active: 0 });
  });

  test('checkout and Manage billing share a budget per account', async () => {
    const [b] = await customer('busy@example.com');
    const a = agent(() => r, 'busy-cli');
    assert.equal((await linkMachine(a, b)).code, 0);
    const checkouts = () => out.calls.filter((c) => c.url === CHECKOUTS).length;
    for (let i = 0; i < 8; i++) assert.equal((await b.post('/v1/account/checkout', { plan: 'plus' })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await a.run('upgrade', 'plus')).code, 0);
    const calls = checkouts();

    const blocked = await b.post('/v1/account/checkout', { plan: 'plus' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, BUDGET);
    assert.equal((await portal(b)).status, 429);
    const cli = await a.run('upgrade', 'plus');
    assert.equal(cli.code, 1);
    assert.equal(cli.err, `${BUDGET}\n`);
    assert.equal(checkouts(), calls);

    // Other accounts have their own budget.
    const [other] = await customer('calm@example.com');
    assert.equal((await other.post('/v1/account/checkout', { plan: 'plus' })).status, 200);

    // A machine that is not linked is counted by its own id.
    const lost = agent(() => r, 'unlinked-cli');
    for (let i = 0; i < 10; i++) assert.match((await lost.run('upgrade', 'plus')).err, /isn't linked/);
    assert.equal((await lost.run('upgrade', 'plus')).err, `${BUDGET}\n`);
  });

  test('callers who are not signed in cannot use up an account budget', async () => {
    const stranger = browser(r);
    for (let i = 0; i < 12; i++) assert.equal((await stranger.post('/v1/account/checkout', { plan: 'plus' })).status, 401);
    assert.equal((await portal(stranger)).status, 401);
    // The origin check comes before the session check.
    assert.equal((await portal(stranger, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const nobody = await fetch(`${r.url}/v1/devices/me/checkout`, { method: 'POST', body: '{}' });
    assert.equal(nobody.status, 401);
  });

  test('a reply without an https link is a 502, not an empty link', async () => {
    const [b, id] = await customer('badlink@example.com');
    for (const attributes of [{}, { url: 'http://pay.example/plain' }, { url: 42 }, { url: '' }]) {
      const res = await answering(CHECKOUTS, () => Response.json({ data: { attributes } }), () =>
        b.post('/v1/account/checkout', { plan: 'plus' }),
      );
      assert.equal(res.status, 502, JSON.stringify(attributes));
      assert.equal(res.body.error, "The payment page didn't load. Try again in a minute.");
    }

    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_badlink'))).status, 200);
    for (const urls of [{}, { customer_portal: 'http://pay.example/plain' }, { customer_portal: null }]) {
      const res = await answering(SUBSCRIPTIONS, () => Response.json({ data: { attributes: { urls } } }), () =>
        portal(b),
      );
      assert.equal(res.status, 502, JSON.stringify(urls));
      assert.equal(res.body.error, "The billing page didn't load. Try again in a minute.");
    }
  });

  test('Manage billing opens the live subscription, and the newest one only when none is live', async () => {
    const [b, id] = await customer('twosubs@example.com');
    const ended = { status: 'expired', ends_at: '2026-10-01T00:00:00.000000Z' };
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_live'))).status, 200);
    assert.equal((await deliver(lemon('subscription_expired', id, ended, 'sub_ended'))).status, 200);
    assert.deepEqual((await portal(b)).body, { url: 'https://pay.example/portal/sub_live' });

    const [c, cid] = await customer('onlyended@example.com');
    assert.equal((await deliver(lemon('subscription_expired', cid, ended, 'sub_gone'))).status, 200);
    assert.deepEqual((await portal(c)).body, { url: 'https://pay.example/portal/sub_gone' });
  });

  test('a Lemon Squeezy error is logged with its own explanation and nothing secret', async () => {
    const [b] = await customer('detail@example.com');
    const res = await answering(
      CHECKOUTS,
      () => Response.json({ errors: [{ detail: 'The selected variant is archived.' }] }, { status: 422 }),
      () => b.post('/v1/account/checkout', { plan: 'plus' }),
    );
    assert.equal(res.status, 502);
    logged('Checkout failed: Lemon Squeezy answered 422 to POST checkouts: The selected variant is archived.');
    for (const line of lines.filter((l) => l.startsWith('Checkout failed'))) {
      assert.ok(!/ls_test|detail@example\.com|whsec/.test(line), line);
    }
  });

  test('an event that retired a subscription is not remembered either', async () => {
    const open: TestRelay[] = [];
    try {
      const first = await relay({ env: FULL_ENV, fetch: out.fetch, log: (line) => lines.push(line) });
      open.push(first);
      const target = { url: first.url };
      const b = browser(target);
      await signIn(b, out, 'retired@example.com');
      const id = await accountIdOf(first.dataDir, 'retired@example.com');
      assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_retired'), 'whsec', first.url)).status, 200);
      assert.equal(await planOf(b), 'pro');

      // The owner mistyped a variant id: Lemon Squeezy's update for this Pro subscription names a product we don't know.
      const retiring = lemon('subscription_updated', id, { variant_id: 888 }, 'sub_retired');
      const remembered = async () => (await sql(first.dataDir, 'SELECT COUNT(*) AS n FROM billing_events'))[0].n;
      const before = await remembered();
      assert.equal((await deliver(retiring, 'whsec', first.url)).status, 200);
      assert.equal(await planOf(b), 'free');
      logged(`Billing subscription_updated (active) for ${id}: not a tunnel plan, subscription ended.`);
      assert.equal(await remembered(), before);
      await first.close();
      open.pop();

      const second = await relay({
        dataDir: first.dataDir,
        env: { ...FULL_ENV, LEMONSQUEEZY_VARIANT_PLUS: '888' },
        fetch: out.fetch,
        log: (line) => lines.push(line),
      });
      open.push(second);
      target.url = second.url;
      assert.equal((await deliver(retiring, 'whsec', second.url)).status, 200);
      assert.equal(await planOf(b), 'plus');
      logged(`Billing subscription_updated (active) for ${id}: applied.`);
    } finally {
      for (const each of open) await each.close();
    }
  });

});

// A relay of its own: the suite above signs in so many accounts that these would hit the relay's
// limit of 20 sign-in emails an hour per client.
describe('billing safeguards', () => {
  const lines: string[] = [];
  const out = outbound({
    [CHECKOUTS]: () => Response.json({ data: { attributes: { url: 'https://pay.example/checkout/abc' } } }),
    [SUBSCRIPTIONS]: (url) =>
      Response.json({
        data: { attributes: { urls: { customer_portal: `https://pay.example/portal/${url.split('/').pop()}` } } },
      }),
  });
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch, log: (line) => lines.push(line), linkPollSeconds: 0.05 });
  });
  after(() => r.close());

  const deliver = (raw: string) =>
    fetch(`${r.url}/v1/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', 'whsec').update(raw).digest('hex') },
      body: raw,
    });
  async function customer(email: string): Promise<[Browser, string]> {
    const b = browser(r);
    await signIn(b, out, email);
    return [b, await accountIdOf(r.dataDir, email)];
  }
  const planOf = async (b: Browser) => (await b.get('/v1/account')).body.plan;
  const logged = (line: string) => assert.ok(lines.includes(line), `missing "${line}" in:\n${lines.join('\n')}`);

  test('a subscription stays with the account it was created for', async () => {
    const [a, aid] = await customer('owner@example.com');
    const [b, bid] = await customer('bystander@example.com');
    const owner = async () =>
      (await sql(r.dataDir, "SELECT account_id FROM subscriptions WHERE provider_id = 'sub_bound'"))[0].account_id;
    assert.equal((await deliver(lemon('subscription_created', aid, {}, 'sub_bound'))).status, 200);
    assert.equal(await planOf(a), 'pro');
    logged(`Billing subscription_created (active) for ${aid}: applied.`);

    // A later event for the same subscription that names another account does not move it.
    const stale = lemon('subscription_updated', bid, {}, 'sub_bound'); // built first, so the older of the two
    assert.equal((await deliver(lemon('subscription_updated', bid, {}, 'sub_bound'))).status, 200);
    assert.equal(await owner(), aid);
    assert.equal(await planOf(a), 'pro');
    assert.equal(await planOf(b), 'free');
    // The log says who really owns it, by id.
    logged(`Billing subscription_updated (active) for ${bid}: applied (stored owner ${aid}).`);
    assert.equal((await deliver(stale)).status, 200);
    logged(`Billing subscription_updated (active) for ${bid}: older than what we have, skipped (stored owner ${aid}).`);

    // It still updates the subscription, and it is the owner's plan that follows.
    const over = lemon('subscription_expired', bid, { status: 'expired', ends_at: '2026-10-01T00:00:00.000000Z' }, 'sub_bound');
    assert.equal((await deliver(over)).status, 200);
    assert.equal(await owner(), aid);
    assert.equal(await planOf(a), 'free');
    assert.equal(await planOf(b), 'free');
    logged(`Billing subscription_expired (expired) for ${bid}: applied (stored owner ${aid}).`);
    for (const line of lines.filter((l) => l.startsWith('Billing '))) assert.ok(!line.includes('@'), line);
  });

  test('an event for a tracked subscription that is not one of our plans names its stored owner too', async () => {
    const [a, aid] = await customer('keeper@example.com');
    const [, bid] = await customer('stranger@example.com');
    assert.equal((await deliver(lemon('subscription_created', aid, {}, 'sub_kept'))).status, 200);
    assert.equal((await deliver(lemon('subscription_updated', bid, { variant_id: 999 }, 'sub_kept'))).status, 200);
    logged(`Billing subscription_updated (active) for ${bid}: not a tunnel plan, subscription ended (stored owner ${aid}).`);
    assert.equal(await planOf(a), 'free');
    // Not tracked: there is no stored owner to name.
    assert.equal((await deliver(lemon('subscription_created', bid, { variant_id: 999 }, 'sub_unknown'))).status, 200);
    logged(`Billing subscription_created (active) for ${bid}: not a tunnel plan, skipped.`);
  });

  test('Manage billing refuses a request that did not come from our own pages', async () => {
    const [b, id] = await customer('crosssite@example.com');
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_cross'))).status, 200);
    const calls = () => out.calls.filter((c) => c.url.startsWith(SUBSCRIPTIONS)).length;
    const before = calls();

    const elsewhere: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'none' },
      {}, // an old client that sends neither header
    ];
    for (let round = 0; round < 3; round++) {
      for (const headers of elsewhere) {
        const res = await portal(b, headers);
        assert.equal(res.status, 403, JSON.stringify(headers));
        assert.equal(res.body.error, ANOTHER_SITE);
      }
    }
    assert.equal(calls(), before, 'Lemon Squeezy was called');

    // Refused requests spent none of the budget: exactly 10 real ones fit.
    const url = { url: 'https://pay.example/portal/sub_cross' };
    assert.deepEqual((await portal(b, { origin: PUBLIC_URL })).body, url);
    for (let i = 0; i < 9; i++) assert.deepEqual((await portal(b)).body, url);
    assert.equal((await portal(b)).status, 429);
  });

  /** A checkout that Lemon Squeezy refuses with this explanation. */
  const refusedWith = (b: Browser, detail: string) =>
    answering(CHECKOUTS, () => Response.json({ errors: [{ detail }] }, { status: 422 }), () =>
      b.post('/v1/account/checkout', { plan: 'plus' }),
    );
  async function answering<T>(url: string, route: Route, fn: () => Promise<T>): Promise<T> {
    const saved = out.table[url];
    out.table[url] = route;
    try {
      return await fn();
    } finally {
      out.table[url] = saved;
    }
  }
  const PREFIX = 'Checkout failed: Lemon Squeezy answered 422 to POST checkouts: ';

  test('a Lemon Squeezy error is redacted before it is logged', async () => {
    const [b] = await customer('redact@example.com');
    assert.equal((await refusedWith(b, 'Customer ada@example.com was rejected for key ls_test.')).status, 502);
    logged(`${PREFIX}Customer [email] was rejected for key [key].`);
    assert.equal((await refusedWith(b, 'x'.repeat(300))).status, 502);
    logged(`${PREFIX}${'x'.repeat(200)}`);
    // The email sits across the 200-character cut. Cutting first would leave "ada@" in the log.
    assert.equal((await refusedWith(b, `${'z'.repeat(195)} ada@example.com`)).status, 502);
    logged(`${PREFIX}${'z'.repeat(195)} [ema`);
    for (const line of lines.filter((l) => l.startsWith('Checkout failed'))) {
      assert.ok(!/ada@|ls_test/.test(line), line);
    }
  });

  test('a long reply with no spaces is redacted at once, not after a second of CPU', async () => {
    const [b] = await customer('long@example.com');
    assert.equal((await refusedWith(b, 'warm up')).status, 502);
    const timed = async (detail: string) => {
      const started = performance.now();
      const res = await refusedWith(b, detail);
      assert.equal(res.status, 502);
      return performance.now() - started;
    };

    const plain = await timed('x'.repeat(40_000));
    logged(`${PREFIX}${'x'.repeat(200)}`);
    assert.ok(plain < 100, `40,000 characters took ${Math.round(plain)} ms`);

    // An address in front of the same wall of text is still found, and the wall is cut after that.
    const mixed = await timed(`ada@example.com ${'x'.repeat(40_000)}`);
    logged(`${PREFIX}[email] ${'x'.repeat(192)}`);
    assert.ok(mixed < 100, `an address plus 40,000 characters took ${Math.round(mixed)} ms`);

    // Nothing but at-signs and letters, the worst case for a pattern that backtracks.
    const dense = await timed('a@b@c@d@'.repeat(5000));
    assert.ok(dense < 100, `40,000 characters of addresses took ${Math.round(dense)} ms`);
    for (const line of lines.filter((l) => l.startsWith('Checkout failed'))) {
      assert.ok(!/ada@/.test(line), line);
    }
  });
});

describe('billing switched off', () => {
  const out = outbound();
  const withoutBilling = Object.fromEntries(Object.entries(FULL_ENV).filter(([key]) => !key.startsWith('LEMONSQUEEZY_')));
  let accounts: TestRelay;
  let plain: TestRelay;
  before(async () => {
    accounts = await relay({ env: withoutBilling, fetch: out.fetch, linkPollSeconds: 0.05 });
    plain = await relay();
  });
  after(async () => {
    await accounts.close();
    await plain.close();
  });

  test('tunnel upgrade lists the plans but says paid plans are not open', async () => {
    for (const target of [accounts, plain]) {
      const a = agent(() => target, 'off');
      assert.equal((await a.run('upgrade')).out, TABLE + `Paid plans aren't open on ${target.url} yet.\n`);
      assert.equal(JSON.parse((await a.run('upgrade', '--json')).out).billing, false);
      const pay = await a.run('upgrade', 'plus');
      assert.equal(pay.code, 1);
      assert.equal(pay.err, `The relay at ${target.url} doesn't sell plans.\n`);
    }
  });

  test('the billing routes do not exist and the account has no subscription', async () => {
    const b = browser(accounts);
    await signIn(b, out, 'free@example.com');
    assert.equal((await b.post('/v1/account/checkout', { plan: 'pro' })).status, 404);
    assert.equal((await b.get('/v1/account/portal')).status, 404);
    const hook = await fetch(`${accounts.url}/v1/billing/webhook`, { method: 'POST', body: '{}' });
    assert.equal(hook.status, 404);
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'free');
    assert.equal(me.subscription, null);
  });
});

// What each Lemon Squeezy status means for the customer's plan. The `active` flag decides who gets
// a paid plan, so the whole mapping is pinned here, status by status.
describe('Lemon Squeezy status mapping', () => {
  const provider = lemonSqueezy(
    { apiKey: 'ls_test', storeId: '11', webhookSecret: 'whsec', variants: { plus: '101', pro: '102' } },
    PUBLIC_URL,
    fetch,
  );
  // parse never reads the clock: "past" and "future" only name the two dates, to show that ends_at alone
  // does not decide the flag (the sweep and the live filter stop a plan at its end date).
  const ENDS = { none: null, past: '2026-09-01T00:00:00.000000Z', future: '2026-12-01T00:00:00.000000Z' } as const;

  // [status, ends_at, whether the customer has the plan]
  const table: [string, keyof typeof ENDS, boolean][] = [
    ['active', 'none', true],
    ['on_trial', 'none', true],
    ['past_due', 'none', true],
    ['paused', 'none', false],
    ['paused', 'future', false],
    ['unpaid', 'none', false],
    ['expired', 'none', false],
    ['expired', 'past', false],
    ['cancelled', 'future', true], // runs until the end date
    ['cancelled', 'past', true],
    ['cancelled', 'none', false],
    ['something_new', 'none', false], // an unknown status fails closed
  ];

  for (const [status, when, active] of table) {
    test(`${status}, end date ${when}: ${active ? 'the customer has the plan' : 'no plan'}`, () => {
      const endsAt = ENDS[when];
      const event = provider.parse(Buffer.from(lemon('subscription_updated', 'a_1', { status, ends_at: endsAt }, 'sub_map')));
      assert.ok(event);
      assert.equal(event.status, status);
      assert.equal(event.active, active);
      assert.equal(event.endsAt, endsAt ? Date.parse(endsAt) : null);
      assert.equal(event.plan, 'pro');
      assert.equal(event.subscriptionId, 'sub_map');
      assert.equal(event.accountId, 'a_1');
    });
  }

  test('the product decides the plan: 101 is Plus, 102 is Pro, anything else is none', () => {
    const planOf = (variant: unknown) =>
      provider.parse(Buffer.from(lemon('subscription_created', 'a_1', { variant_id: variant })))?.plan;
    assert.equal(planOf(101), 'plus');
    assert.equal(planOf('101'), 'plus');
    assert.equal(planOf(102), 'pro');
    assert.equal(planOf(999), null);
    assert.equal(planOf(undefined), null);
  });
});
