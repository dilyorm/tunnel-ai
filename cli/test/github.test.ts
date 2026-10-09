import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FULL_ENV, PUBLIC_URL, browser, outbound, relay, signIn, sql, type Browser, type TestRelay } from './helpers.js';

const TOKEN = 'https://github.com/login/oauth/access_token';
const USER = 'https://api.github.com/user';
const EMAILS = 'https://api.github.com/user/emails';

/** Start a sign-in in this browser. Returns GitHub's authorize URL. */
async function start(b: Browser, returnTo = '/account') {
  const res = await b.get(`/v1/auth/github/start?return=${encodeURIComponent(returnTo)}`);
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')!);
}

const stateOf = async (b: Browser) => (await start(b)).searchParams.get('state')!;
const back = async (b: Browser, query: string) => (await b.get(`/v1/auth/github/callback?${query}`)).headers.get('location');

describe('GitHub sign-in', () => {
  const out = outbound({
    [TOKEN]: () => Response.json({ access_token: 'gho_test', token_type: 'bearer' }),
    [USER]: () => Response.json({ id: 42, login: 'octocat' }),
    [EMAILS]: () =>
      Response.json([
        { email: 'octo@work.example', primary: false, verified: true },
        { email: 'Octo@Example.com', primary: true, verified: true },
      ]),
  });
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch });
  });
  after(() => r.close());

  test('GitHub sign-in sends you back where you started, signed in', async () => {
    const b = browser(r);
    const authorize = await start(b, '/account?plan=plus');
    assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(authorize.searchParams.get('client_id'), 'gh-id');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${PUBLIC_URL}/v1/auth/github/callback`);
    assert.equal(authorize.searchParams.get('scope'), 'user:email');
    const state = authorize.searchParams.get('state')!;
    assert.equal(b.jar.get('tunnel_oauth'), state);

    assert.equal(await back(b, `code=abc&state=${state}`), '/account?plan=plus');
    assert.equal(b.jar.has('tunnel_oauth'), false);
    assert.equal(b.jar.has('tunnel_session'), true);
    const exchange = out.calls.find((c) => c.url === TOKEN)!;
    assert.equal(exchange.body.code, 'abc');
    assert.equal(exchange.body.client_secret, 'gh-secret');

    const me = await b.get('/v1/account');
    assert.equal(me.body.email, 'octo@example.com');
    assert.equal(me.body.githubLogin, 'octocat');
  });

  test('a sign-in started in another browser is refused', async () => {
    const starter = browser(r);
    const state = await stateOf(starter);
    const victim = browser(r);
    assert.equal(await back(victim, `code=abc&state=${state}`), '/account?error=github-state');
    assert.equal(victim.jar.has('tunnel_session'), false);
    // The refused attempt did not spend the state: the browser that started it can still finish.
    assert.equal(await back(starter, `code=abc&state=${state}`), '/account');
    assert.equal(starter.jar.has('tunnel_session'), true);
  });

  test('a return path that leaves the site ends at /account', async () => {
    for (const returnTo of ['//evil.com', '/\\evil.com']) {
      const b = browser(r);
      const state = (await start(b, returnTo)).searchParams.get('state')!;
      assert.equal(await back(b, `code=abc&state=${state}`), '/account');
      assert.equal(b.jar.has('tunnel_session'), true);
    }
  });

  test('a state works once', async () => {
    const b = browser(r);
    const state = await stateOf(b);
    assert.equal(await back(b, `code=abc&state=${state}`), '/account');
    b.jar.set('tunnel_oauth', state); // replay, with the cookie put back
    assert.equal(await back(b, `code=abc&state=${state}`), '/account?error=github-state');
  });

  test('a cancelled sign-in, a missing email and a GitHub outage each get their own code', async () => {
    const denied = browser(r);
    assert.equal(await back(denied, `error=access_denied&state=${await stateOf(denied)}`), '/account?error=github-denied');

    const emails = out.table[EMAILS];
    out.table[EMAILS] = () => Response.json([{ email: 'octo@example.com', primary: true, verified: false }]);
    try {
      const b = browser(r);
      assert.equal(await back(b, `code=abc&state=${await stateOf(b)}`), '/account?error=github-email');
    } finally {
      out.table[EMAILS] = emails;
    }

    const token = out.table[TOKEN];
    out.table[TOKEN] = () => new Response('', { status: 500 });
    try {
      const b = browser(r);
      assert.equal(await back(b, `code=abc&state=${await stateOf(b)}`), '/account?error=github');
    } finally {
      out.table[TOKEN] = token;
    }
  });

  test('the primary email is trimmed and checked like an address typed into the sign-in form', async () => {
    const profile = out.table[USER];
    const emails = out.table[EMAILS];
    try {
      out.table[USER] = () => Response.json({ id: 77, login: 'padded' });
      out.table[EMAILS] = () => Response.json([{ email: '  Padded@Example.com ', primary: true, verified: true }]);
      const b = browser(r);
      assert.equal(await back(b, `code=abc&state=${await stateOf(b)}`), '/account');
      assert.equal((await b.get('/v1/account')).body.email, 'padded@example.com');

      out.table[USER] = () => Response.json({ id: 78, login: 'garbled' });
      out.table[EMAILS] = () => Response.json([{ email: 'not an address', primary: true, verified: true }]);
      const c = browser(r);
      assert.equal(await back(c, `code=abc&state=${await stateOf(c)}`), '/account?error=github-email');
      assert.equal(c.jar.has('tunnel_session'), false);
      assert.deepEqual(await sql(r.dataDir, 'SELECT id FROM accounts WHERE github_id = 78'), []);
    } finally {
      out.table[USER] = profile;
      out.table[EMAILS] = emails;
    }
  });

  test('a GitHub profile without an id or login is an outage, not a crash', async () => {
    const profile = out.table[USER];
    try {
      for (const answer of [{}, { id: '42', login: 'octocat' }, { id: 42 }]) {
        out.table[USER] = () => Response.json(answer);
        const b = browser(r);
        assert.equal(await back(b, `code=abc&state=${await stateOf(b)}`), '/account?error=github');
        assert.equal(b.jar.has('tunnel_session'), false);
      }
    } finally {
      out.table[USER] = profile;
    }
  });
});

describe('one person, one account', () => {
  let emails = [{ email: 'mona@example.com', primary: true, verified: true }];
  const out = outbound({
    [TOKEN]: () => Response.json({ access_token: 'gho_test' }),
    [USER]: () => Response.json({ id: 7, login: 'mona' }),
    [EMAILS]: () => Response.json(emails),
  });
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch });
  });
  after(() => r.close());

  test('GitHub sign-in joins the account that has the same email', async () => {
    await signIn(browser(r), out, 'mona@example.com');
    const b = browser(r);
    assert.equal(await back(b, `code=abc&state=${await stateOf(b)}`), '/account');
    assert.equal((await b.get('/v1/account')).body.githubLogin, 'mona');
    assert.deepEqual(await sql(r.dataDir, 'SELECT email, github_id FROM accounts'), [
      { email: 'mona@example.com', github_id: 7 },
    ]);
  });

  test('a changed GitHub email still finds the account by GitHub id', async () => {
    emails = [{ email: 'mona@new.example', primary: true, verified: true }];
    const b = browser(r);
    assert.equal(await back(b, `code=abc&state=${await stateOf(b)}`), '/account');
    assert.equal((await b.get('/v1/account')).body.email, 'mona@example.com');
    assert.equal((await sql(r.dataDir, 'SELECT COUNT(*) AS n FROM accounts'))[0].n, 1);
  });
});

describe('an address that belongs to another GitHub user', () => {
  let user = { id: 1, login: 'first' };
  const out = outbound({
    [TOKEN]: () => Response.json({ access_token: 'gho_test' }),
    [USER]: () => Response.json(user),
    [EMAILS]: () => Response.json([{ email: 'shared@example.com', primary: true, verified: true }]),
  });
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch });
  });
  after(() => r.close());

  test('never moves a GitHub-linked account to someone else', async () => {
    const owner = browser(r);
    assert.equal(await back(owner, `code=abc&state=${await stateOf(owner)}`), '/account');

    // The mailbox now belongs to another GitHub user, who has it as primary and verified.
    user = { id: 2, login: 'second' };
    const other = browser(r);
    assert.equal(await back(other, `code=abc&state=${await stateOf(other)}`), '/account?error=github-taken');
    assert.equal(other.jar.has('tunnel_session'), false);
    assert.deepEqual(await sql(r.dataDir, 'SELECT email, github_id, github_login FROM accounts'), [
      { email: 'shared@example.com', github_id: 1, github_login: 'first' },
    ]);

    // The first user still signs in to their own account.
    user = { id: 1, login: 'first' };
    const again = browser(r);
    assert.equal(await back(again, `code=abc&state=${await stateOf(again)}`), '/account');
    assert.equal((await again.get('/v1/account')).body.githubLogin, 'first');
  });
});
