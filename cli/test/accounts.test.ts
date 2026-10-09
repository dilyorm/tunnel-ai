import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/crypto.js';
import { limiterKey } from '../src/relay/auth-email.js';
import { clientKey, safeReturn } from '../src/relay/http.js';
import {
  FULL_ENV,
  PUBLIC_URL,
  agent,
  browser,
  follow,
  grant,
  outbound,
  relay,
  signIn,
  sql,
  type TestRelay,
} from './helpers.js';

describe('email sign-in', () => {
  const out = outbound();
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch });
  });
  after(() => r.close());

  test('methods lists the sign-in options this relay has', async () => {
    assert.deepEqual((await browser(r).get('/v1/auth/methods')).body, { github: true, email: true, billing: true });
  });

  test('the emailed link signs you in with a 30-day HttpOnly cookie', async () => {
    const b = browser(r);
    const ask = await b.post('/v1/auth/email', { email: ' Ada@Example.com ', return: '/account?plan=pro' });
    assert.equal(ask.status, 202);
    const mail = out.calls.at(-1)!;
    assert.equal(mail.url, 'https://api.resend.com/emails');
    assert.deepEqual(mail.body.to, ['ada@example.com']);
    assert.equal(mail.body.from, FULL_ENV.TUNNEL_EMAIL_FROM);
    assert.equal(new Headers(mail.init.headers).get('authorization'), 'Bearer re_test');

    const link = new URL(out.lastLink());
    assert.equal(link.origin + link.pathname, `${PUBLIC_URL}/v1/auth/email/verify`);
    const done = await follow(b, link.href);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { returnTo: '/account?plan=pro' });
    const [session, hint] = done.headers.getSetCookie();
    assert.match(session, /^tunnel_session=[\w-]{43}; Path=\/; Max-Age=2592000; SameSite=Lax; HttpOnly$/);
    assert.equal(hint, 'tunnel_signed_in=1; Path=/; Max-Age=2592000; SameSite=Lax');

    const me = await b.get('/v1/account');
    assert.equal(me.status, 200);
    assert.equal(me.body.email, 'ada@example.com');
    assert.equal(me.body.plan, 'free');
    assert.equal(me.body.limits.fileBytes, 10 * 1024 * 1024);
    assert.deepEqual(me.body.usage, { tunnels: 0, storageBytes: 0 });
    assert.deepEqual(me.body.devices, []);
    assert.equal(me.body.subscription, null);
    assert.equal(me.body.admin, false);
  });

  test('a mail scanner opening the link does not use it up', async () => {
    const b = browser(r);
    assert.equal((await b.post('/v1/auth/email', { email: 'scan@example.com' })).status, 202);
    const link = out.lastLink();
    for (let i = 0; i < 2; i++) {
      const scan = await fetch(link.replace(PUBLIC_URL, r.url), { redirect: 'manual' });
      assert.equal(scan.status, 302);
      assert.deepEqual(scan.headers.getSetCookie(), []);
    }
    assert.equal((await follow(b, link)).status, 200);
    assert.equal((await b.get('/v1/account')).body.email, 'scan@example.com');
    const again = await follow(browser(r), link);
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'This sign-in link expired or was already used. Ask for a new one.');
  });

  test('the link is tied to the browser that asked for it, by an HttpOnly cookie', async () => {
    const b = browser(r);
    const ask = await b.post('/v1/auth/email', { email: 'bind@example.com' });
    assert.equal(ask.status, 202);
    const token = new URL(out.lastLink()).searchParams.get('token')!;
    assert.deepEqual(ask.headers.getSetCookie(), [
      `tunnel_login=${sha256(`bind:${token}`)}; Path=/; Max-Age=900; SameSite=Lax; HttpOnly`,
    ]);
    const done = await follow(b, out.lastLink());
    assert.equal(done.status, 200);
    assert.ok(done.headers.getSetCookie().includes('tunnel_login=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly'));
    assert.equal(b.jar.has('tunnel_login'), false);
  });

  test('a link opened in a browser that did not ask for it is not spent without a confirmation', async () => {
    const attacker = browser(r);
    assert.equal((await attacker.post('/v1/auth/email', { email: 'Mallory@Example.com' })).status, 202);
    const link = out.lastLink();

    // The victim has a sign-in of their own pending, so they hold a tunnel_login cookie too.
    const victim = browser(r);
    assert.equal((await victim.post('/v1/auth/email', { email: 'victim@example.com' })).status, 202);
    const asked = await follow(victim, link);
    assert.equal(asked.status, 409);
    assert.deepEqual(asked.body, { error: 'Confirm this sign-in.', confirm: 'm…@example.com' });
    assert.deepEqual(asked.headers.getSetCookie(), []);
    assert.equal((await victim.get('/v1/account')).status, 401);

    // Nothing was spent: the browser that asked for the link still signs in with it.
    assert.equal((await follow(attacker, link)).status, 200);
    assert.equal((await attacker.get('/v1/account')).body.email, 'mallory@example.com');
  });

  test('a person who opens their link in another browser can confirm it', async () => {
    assert.equal((await browser(r).post('/v1/auth/email', { email: 'phone@example.com', return: '/account?plan=plus' })).status, 202);
    const link = out.lastLink();
    const other = browser(r);
    assert.equal((await follow(other, link)).status, 409);
    const done = await follow(other, link, true);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { returnTo: '/account?plan=plus' });
    assert.equal((await other.get('/v1/account')).body.email, 'phone@example.com');
    // Confirming spends it like any other sign-in.
    assert.equal((await follow(browser(r), link, true)).status, 410);
  });

  test('confirming a link that is invalid or expired changes nothing', async () => {
    const message = 'This sign-in link expired or was already used. Ask for a new one.';
    const stranger = browser(r);
    for (const body of [{ token: 'nope', confirm: true }, { token: 'nope' }, { confirm: true }, { token: 5, confirm: true }]) {
      const res = await stranger.post('/v1/auth/email/verify', body);
      assert.equal(res.status, 410, JSON.stringify(body));
      assert.equal(res.body.error, message);
    }
    assert.equal((await browser(r).post('/v1/auth/email', { email: 'stale@example.com' })).status, 202);
    const link = out.lastLink();
    await sql(r.dataDir, 'UPDATE email_logins SET expires = 1');
    for (const confirm of [false, true]) {
      const res = await follow(browser(r), link, confirm);
      assert.equal(res.status, 410, `confirm ${confirm}`);
      assert.equal(res.body.error, message);
    }
    assert.deepEqual(await sql(r.dataDir, "SELECT id FROM accounts WHERE email = 'stale@example.com'"), []);
  });

  test('an expired link is refused', async () => {
    const b = browser(r);
    assert.equal((await b.post('/v1/auth/email', { email: 'late@example.com' })).status, 202);
    await sql(r.dataDir, 'UPDATE email_logins SET expires = 1');
    assert.equal((await follow(b, out.lastLink())).status, 410);
  });

  test('return_to only accepts paths on this site', async () => {
    const bad = [
      '//evil.com',
      '/\\evil.com',
      '/\tevil.com',
      'https://evil.com/',
      'javascript:alert(1)',
      'account',
      '/' + 'a'.repeat(600),
      // A browser resolves these to //evil.com:
      '/.//evil.com',
      '/..//evil.com',
      '/a/..//evil.com',
    ];
    for (const value of bad) assert.equal(safeReturn(value), '/account', JSON.stringify(value));
    assert.equal(safeReturn(undefined), '/account');
    assert.equal(safeReturn('/account?plan=plus&link=ABCD-EFGH'), '/account?plan=plus&link=ABCD-EFGH');
    assert.equal(safeReturn('/account/billing?x=1#top'), '/account/billing?x=1#top');
    // And end to end, through an emailed link:
    assert.equal(await signIn(browser(r), out, 'away@example.com', '//evil.com'), '/account');
    assert.equal(await signIn(browser(r), out, 'home@example.com', '/\\evil.com'), '/account');
  });

  test('POSTs from another site are refused', async () => {
    const evil = browser(r, 'https://evil.example');
    for (const path of ['/v1/auth/email', '/v1/auth/email/verify', '/v1/auth/logout']) {
      const res = await evil.post(path, { email: 'x@example.com', token: 'x' });
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error, 'This request came from another site, so it was blocked.');
    }
  });

  test('signing out ends the session for good', async () => {
    const b = browser(r);
    await signIn(b, out, 'bye@example.com');
    const cookie = b.jar.get('tunnel_session')!;
    assert.equal((await b.post('/v1/auth/logout')).status, 204);
    assert.equal(b.jar.size, 0);
    const old = await fetch(`${r.url}/v1/account`, { headers: { cookie: `tunnel_session=${cookie}` } });
    assert.equal(old.status, 401);
    assert.deepEqual(await old.json(), { error: 'Sign in first.' });
  });

  test('a bad address gets a plain 400', async () => {
    const res = await browser(r).post('/v1/auth/email', { email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Enter a valid email address.');
  });

  test('when the email cannot be sent, the person is told and no link is left behind', async () => {
    const resend = out.table['https://api.resend.com/emails'];
    out.table['https://api.resend.com/emails'] = () => new Response('down', { status: 500 });
    try {
      const res = await browser(r).post('/v1/auth/email', { email: 'nomail@example.com' });
      assert.equal(res.status, 502);
      assert.equal(res.body.error, "Couldn't send the email. Try again or sign in with GitHub.");
      assert.deepEqual(await sql(r.dataDir, "SELECT * FROM email_logins WHERE email = 'nomail@example.com'"), []);
    } finally {
      out.table['https://api.resend.com/emails'] = resend;
    }
  });

  test('you can only unlink machines on your own account', async () => {
    const mine = browser(r);
    await signIn(mine, out, 'owner@example.com');
    const theirs = agent(() => r, 'unlink-theirs');
    assert.equal((await theirs.run('open', 'x')).code, 0);
    const deviceId = theirs.deviceId();
    const stranger = await grant(r.dataDir, 'free', deviceId);

    const res = await mine.post(`/v1/account/devices/${deviceId}/unlink`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "That machine isn't linked to your account.");
    assert.deepEqual(await sql(r.dataDir, 'SELECT account_id FROM devices WHERE id = ?', deviceId), [
      { account_id: stranger },
    ]);
  });

  test('you can unlink a machine on your own account', async () => {
    const b = browser(r);
    await signIn(b, out, 'unlinker@example.com');
    const mine = agent(() => r, 'unlink-mine');
    assert.equal((await mine.run('open', 'x')).code, 0);
    const deviceId = mine.deviceId();
    const [{ id: accountId }] = await sql(r.dataDir, "SELECT id FROM accounts WHERE email = 'unlinker@example.com'");
    await sql(r.dataDir, 'UPDATE devices SET account_id = ? WHERE id = ?', accountId, deviceId);

    const listed = (await b.get('/v1/account')).body.devices;
    assert.deepEqual(listed.map((d: { id: string; tunnels: number }) => [d.id, d.tunnels]), [[deviceId, 1]]);
    assert.equal((await b.post(`/v1/account/devices/${deviceId}/unlink`)).status, 204);
    assert.deepEqual((await b.get('/v1/account')).body.devices, []);
    assert.deepEqual(await sql(r.dataDir, 'SELECT account_id FROM devices WHERE id = ?', deviceId), [{ account_id: null }]);
  });
});

describe('sign-in email limits', () => {
  test('one address gets at most 5 links an hour', async () => {
    const out = outbound();
    const r = await relay({ env: FULL_ENV, fetch: out.fetch });
    try {
      const b = browser(r);
      for (let i = 0; i < 5; i++) {
        assert.equal((await b.post('/v1/auth/email', { email: 'many@example.com' })).status, 202);
      }
      const sixth = await b.post('/v1/auth/email', { email: 'many@example.com' });
      assert.equal(sixth.status, 429);
      assert.match(sixth.body.error, /for this address/);
      assert.equal((await b.post('/v1/auth/email', { email: 'other@example.com' })).status, 202);
    } finally {
      await r.close();
    }
  });

  test('plus tags, Gmail dots and googlemail.com share one address budget', async () => {
    const out = outbound();
    const r = await relay({ env: FULL_ENV, fetch: out.fetch });
    try {
      const b = browser(r);
      // The account keeps the address as typed; only the limiter folds the spellings together.
      await signIn(b, out, ' V.+2@Googlemail.com ');
      assert.equal((await b.get('/v1/account')).body.email, 'v.+2@googlemail.com');
      assert.deepEqual(out.calls.at(-1)!.body.to, ['v.+2@googlemail.com']);

      for (const email of ['v@gmail.com', 'v+1@gmail.com', 'v..@gmail.com', 'v+x+y@googlemail.com']) {
        assert.equal((await b.post('/v1/auth/email', { email })).status, 202, email);
      }
      const sixth = await b.post('/v1/auth/email', { email: 'v.+3@googlemail.com' });
      assert.equal(sixth.status, 429);
      assert.match(sixth.body.error, /for this address/);
      // A different mailbox is a different budget.
      assert.equal((await b.post('/v1/auth/email', { email: 'vv@gmail.com' })).status, 202);
    } finally {
      await r.close();
    }
  });

  test('limiterKey folds only the spellings that reach the same mailbox', () => {
    assert.equal(limiterKey('ada+news@example.com'), 'ada@example.com');
    assert.equal(limiterKey('a.da@example.com'), 'a.da@example.com');
    assert.equal(limiterKey('a.d.a+x@googlemail.com'), 'ada@gmail.com');
    assert.equal(limiterKey('a.da@gmail.com'), 'ada@gmail.com');
    assert.equal(limiterKey('+x@example.com'), '+x@example.com');
  });

  /** A sign-in request that looks, to a relay behind a proxy, like it came from `client`. */
  const askFrom = async (r: TestRelay, client: string, email: string) => {
    const res = await fetch(`${r.url}/v1/auth/email`, {
      method: 'POST',
      headers: { origin: PUBLIC_URL, 'content-type': 'application/json', 'x-forwarded-for': client },
      body: JSON.stringify({ email }),
    });
    return { status: res.status, body: (await res.json()) as { error: string } };
  };

  test('an IPv6 client cannot dodge the per-network limit by rotating addresses in its /64', async () => {
    const out = outbound();
    const r = await relay({ env: FULL_ENV, fetch: out.fetch, trustProxy: true });
    try {
      for (let i = 1; i <= 20; i++) {
        assert.equal((await askFrom(r, `2001:db8:1:2::${i.toString(16)}`, `rotate${i}@example.com`)).status, 202);
      }
      const next = await askFrom(r, '2001:db8:1:2:ffff:ffff:ffff:ffff', 'rotate21@example.com');
      assert.equal(next.status, 429);
      assert.match(next.body.error, /from this network/);
      assert.equal((await askFrom(r, '2001:db8:1:3::1', 'elsewhere@example.com')).status, 202);
    } finally {
      await r.close();
    }
  });

  test('the relay sends at most 100 sign-in emails an hour, whoever asks', async () => {
    const out = outbound();
    const r = await relay({ env: FULL_ENV, fetch: out.fetch, trustProxy: true });
    try {
      for (let i = 0; i < 100; i++) {
        const res = await askFrom(r, `10.1.${Math.floor(i / 250)}.${(i % 250) + 1}`, `user${i}@example.com`);
        assert.equal(res.status, 202, `request ${i + 1}`);
      }
      const over = await askFrom(r, '10.9.9.9', 'one-too-many@example.com');
      assert.equal(over.status, 429);
      assert.match(over.body.error, /sign-in emails are being sent right now/);
      assert.equal(out.calls.length, 100);
    } finally {
      await r.close();
    }
  });
});

describe('client keys', () => {
  test('IPv6 clients count as their /64, and IPv4 stays as it is', () => {
    assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientKey('::FFFF:cb00:7107'), '203.0.113.7');

    const net = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    assert.equal(net, '2001:db8:1:2::/64');
    for (const same of ['2001:db8:1:2::1', '2001:0DB8:0001:0002:0:0:0:ff', '[2001:db8:1:2::9]', '2001:db8:1:2::']) {
      assert.equal(clientKey(same), net, same);
    }
    assert.notEqual(clientKey('2001:db8:1:3::1'), net);
    assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(clientKey('::1'), clientKey('::2'));
    assert.equal(clientKey('64:ff9b::198.51.100.1'), '64:ff9b:0:0::/64');
  });

  test('anything that is not an address is used as it came', () => {
    for (const odd of ['unknown', 'not:an:address', '1.2.3.4:5678', '1::2::3', '12345::1', '1:2:3:4:5:6:7:8:9', '::ffff:1.2.3.999']) {
      assert.equal(clientKey(odd), odd);
    }
  });
});
