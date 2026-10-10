import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCode, normalizeCode } from '../src/relay/accounts.js';
import { FULL_ENV, PUBLIC_URL, agent, browser, linkMachine, outbound, relay, signIn, sql, until, type TestRelay } from './helpers.js';

describe('linking a machine', () => {
  const out = outbound();
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch, maxTunnelsPerDevice: 1, linkPollSeconds: 0.05 });
  });
  after(() => r.close());

  test('codes read the same however they are typed', () => {
    assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
    assert.equal(normalizeCode(undefined), '');
    assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
  });

  test('tunnel login links this machine once you confirm the code in the browser', async () => {
    const b = browser(r);
    await signIn(b, out, 'ada@example.com');
    const a = agent(() => r, 'link-ada');
    assert.equal((await a.run('open', 'work')).code, 0);

    const login = await linkMachine(a, b);
    assert.equal(login.code, 0, login.err);
    assert.match(login.out, /^To link this machine, open http:\/\/tunnel\.test\/account\?link=[2-9A-Z]{4}-[2-9A-Z]{4}$/m);
    assert.match(login.out, /^Linked to ada@example\.com \(Free\)\.$/m);

    const page = (await b.get('/v1/account')).body;
    assert.deepEqual(
      page.devices.map((d: { id: string; tunnels: number }) => [d.id, d.tunnels]),
      [[a.deviceId(), 1]],
    );
    assert.equal(page.usage.tunnels, 1);

    assert.equal(
      (await a.run('account')).out,
      'ada@example.com  Free plan\nTunnels  1 of 1 on this machine\nFiles    up to 10 MB each\nHistory  7 days\n',
    );
    await sql(r.dataDir, "UPDATE accounts SET plan = 'plus', plan_source = 'admin' WHERE email = 'ada@example.com'");
    assert.equal(
      (await a.run('account')).out,
      'ada@example.com  Plus plan\nTunnels  1 of 10 on this account\nFiles    up to 50 MB each, 0 B of 2 GB stored\nHistory  30 days\n',
    );
  });

  test('a wrong or expired code links nothing', async () => {
    const b = browser(r);
    await signIn(b, out, 'bob@example.com');
    const wrong = await b.post('/v1/account/devices/link', { userCode: 'ZZZZ-ZZZZ' });
    assert.equal(wrong.status, 404);
    assert.equal(wrong.body.error, 'That code is wrong or has expired. Run `tunnel login` again for a new one.');

    const a = agent(() => r, 'link-late');
    const login = a.run('login');
    const url = await until(() => a.opened[0]);
    await sql(r.dataDir, 'UPDATE device_links SET expires = 1');
    const userCode = new URL(url).searchParams.get('link');
    assert.equal((await b.post('/v1/account/devices/link', { userCode })).status, 404);
    const result = await login;
    assert.equal(result.code, 1);
    assert.equal(result.err, 'The code expired before it was confirmed. Run `tunnel login` again.\n');
  });

  test('tunnel logout unlinks the machine and keeps its tunnels', async () => {
    const b = browser(r);
    await signIn(b, out, 'cy@example.com');
    const a = agent(() => r, 'link-cy');
    assert.equal((await a.run('open', 'keep')).code, 0);
    assert.equal((await linkMachine(a, b)).code, 0);

    assert.equal(
      (await a.run('logout')).out,
      "Unlinked this machine from cy@example.com. Its tunnels stay open on the Free plan's limits.\n",
    );
    assert.match((await a.run('ls')).out, /keep/);
    assert.deepEqual((await b.get('/v1/account')).body.devices, []);
    assert.equal((await a.run('logout')).out, "This machine isn't linked to an account.\n");
    assert.match((await a.run('account')).out, /^Not signed in \(Free plan\)\. Run `tunnel login`/);
  });

  test('the account page can unlink a machine, but only its own', async () => {
    const b = browser(r);
    await signIn(b, out, 'dee@example.com');
    const a = agent(() => r, 'link-dee');
    assert.equal((await linkMachine(a, b)).code, 0);

    const stranger = browser(r);
    await signIn(stranger, out, 'eve@example.com');
    assert.equal((await stranger.post(`/v1/account/devices/${a.deviceId()}/unlink`)).status, 404);
    assert.equal((await b.post(`/v1/account/devices/${a.deviceId()}/unlink`)).status, 204);
    assert.match((await a.run('account')).out, /^Not signed in/);
  });

  test('guessing codes is cut off after 20 tries', async () => {
    const b = browser(r);
    await signIn(b, out, 'guess@example.com');
    for (let i = 0; i < 20; i++) {
      assert.equal((await b.post('/v1/account/devices/link', { userCode: `AAAA-AA${i}` })).status, 404);
    }
    const blocked = await b.post('/v1/account/devices/link', { userCode: 'AAAA-AAAA' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'Too many link attempts. Wait ten minutes and try again.');
  });

  test('login --json prints the code, then the result', async () => {
    const b = browser(r);
    await signIn(b, out, 'json@example.com');
    const a = agent(() => r, 'link-json');
    const login = await linkMachine(a, b, '--json');
    assert.equal(login.code, 0, login.err);
    const [first, second] = login.out.trim().split('\n').map((line) => JSON.parse(line));
    assert.match(first.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.equal(first.url, `${PUBLIC_URL}/account?link=${first.code}`);
    assert.equal(first.expiresIn, 600);
    assert.deepEqual(second, { email: 'json@example.com', plan: 'free' });
    assert.deepEqual(JSON.parse((await a.run('account', '--json')).out).account, { email: 'json@example.com' });
  });
});

describe('a relay without accounts', () => {
  test('login and account say the relay has no accounts', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'plain');
      const login = await a.run('login');
      assert.equal(login.code, 1);
      assert.equal(login.err, `The relay at ${r.url} doesn't have accounts.\n`);
      assert.equal((await a.run('account')).err, `The relay at ${r.url} doesn't have accounts.\n`);
    } finally {
      await r.close();
    }
  });
});
