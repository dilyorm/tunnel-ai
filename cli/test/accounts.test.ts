import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturn } from '../src/relay/http.js';
import { FULL_ENV, PUBLIC_URL, browser, follow, outbound, relay, signIn, sql, type TestRelay } from './helpers.js';

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
    assert.equal((await browser(r).post('/v1/auth/email', { email: 'scan@example.com' })).status, 202);
    const link = out.lastLink();
    for (let i = 0; i < 2; i++) {
      const scan = await fetch(link.replace(PUBLIC_URL, r.url), { redirect: 'manual' });
      assert.equal(scan.status, 302);
      assert.deepEqual(scan.headers.getSetCookie(), []);
    }
    const b = browser(r);
    assert.equal((await follow(b, link)).status, 200);
    assert.equal((await b.get('/v1/account')).body.email, 'scan@example.com');
    const again = await follow(browser(r), link);
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'This sign-in link expired or was already used. Ask for a new one.');
  });

  test('an expired link is refused', async () => {
    const b = browser(r);
    assert.equal((await b.post('/v1/auth/email', { email: 'late@example.com' })).status, 202);
    await sql(r.dataDir, 'UPDATE email_logins SET expires = 1');
    assert.equal((await follow(b, out.lastLink())).status, 410);
  });

  test('return_to only accepts paths on this site', async () => {
    const bad = ['//evil.com', '/\\evil.com', '/\tevil.com', 'https://evil.com/', 'javascript:alert(1)', 'account', '/' + 'a'.repeat(600)];
    for (const value of bad) assert.equal(safeReturn(value), '/account', JSON.stringify(value));
    assert.equal(safeReturn(undefined), '/account');
    assert.equal(safeReturn('/account?plan=plus&link=ABCD-EFGH'), '/account?plan=plus&link=ABCD-EFGH');
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
    const b = browser(r);
    await signIn(b, out, 'owner@example.com');
    const res = await b.post('/v1/account/devices/d_someone/unlink');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "That machine isn't linked to your account.");
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
});
