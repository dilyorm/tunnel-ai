import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
  type TestRelay,
} from './helpers.js';

const CHECKOUTS = 'https://api.lemonsqueezy.com/v1/checkouts';
const SUBSCRIPTIONS = 'https://api.lemonsqueezy.com/v1/subscriptions/';

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

  const deliver = (raw: string, secret = 'whsec') =>
    fetch(`${r.url}/v1/billing/webhook`, {
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
    const none = await b.get('/v1/account/portal');
    assert.equal(none.status, 404);
    assert.equal(none.body.error, 'No subscription yet.');
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_portal'))).status, 200);
    assert.deepEqual((await b.get('/v1/account/portal')).body, { url: 'https://pay.example/portal/sub_portal' });
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
    assert.equal(
      (await a.run('upgrade')).out,
      'Plus  $5/month  10 tunnels, files up to 50 MB, 30 days of history, 2 GB of storage\n' +
        'Pro   $9/month  20 tunnels, files up to 100 MB, 30 days of history, 5 GB of storage\n' +
        'Run `tunnel upgrade plus` or `tunnel upgrade pro` to pay.\n',
    );
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
});
