import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFeatures } from '../src/relay/config.js';
import { openStore } from '../src/relay/db.js';
import { DAY, FULL_ENV, agent, relay, sql, tmp } from './helpers.js';

describe('feature settings', () => {
  test('nothing set means a plain relay, silently', () => {
    const lines: string[] = [];
    const f = readFeatures({}, (line) => lines.push(line));
    assert.equal(f.publicUrl, undefined);
    assert.equal(f.github, undefined);
    assert.equal(f.email, undefined);
    assert.equal(f.billing, undefined);
    assert.equal(f.adminEmails.size, 0);
    assert.equal(f.statsSalt, undefined);
    assert.deepEqual(lines, []);
  });

  test('everything set turns everything on', () => {
    const f = readFeatures(FULL_ENV);
    assert.equal(f.publicUrl, 'http://tunnel.test');
    assert.deepEqual(f.github, { clientId: 'gh-id', clientSecret: 'gh-secret' });
    assert.deepEqual(f.email, { apiKey: 're_test', from: 'tunnel <login@tunnel.test>' });
    assert.deepEqual(f.billing, {
      apiKey: 'ls_test',
      storeId: '11',
      webhookSecret: 'whsec',
      variants: { plus: '101', pro: '102' },
    });
    assert.deepEqual([...f.adminEmails], ['boss@example.com']);
    assert.equal(f.statsSalt, 'salt');
  });

  test('half a group stays off, with a warning naming what is missing', () => {
    const lines: string[] = [];
    const f = readFeatures({ TUNNEL_PUBLIC_URL: 'https://t.example/', GITHUB_CLIENT_ID: 'x' }, (line) => lines.push(line));
    assert.equal(f.publicUrl, 'https://t.example');
    assert.equal(f.github, undefined);
    assert.deepEqual(lines, ['GitHub sign-in is off: GITHUB_CLIENT_SECRET is not set.']);
  });

  test('sign-in, billing and admin need a public URL', () => {
    const lines: string[] = [];
    const f = readFeatures({ ...FULL_ENV, TUNNEL_PUBLIC_URL: '' }, (line) => lines.push(line));
    assert.equal(f.github, undefined);
    assert.equal(f.email, undefined);
    assert.equal(f.billing, undefined);
    assert.equal(f.adminEmails.size, 0);
    assert.ok(lines.includes('GitHub sign-in is off: TUNNEL_PUBLIC_URL is not set.'), lines.join('\n'));
    assert.ok(lines.includes('Admin is off: TUNNEL_PUBLIC_URL is not set.'), lines.join('\n'));
  });

  test('a public URL with a path is refused', () => {
    const lines: string[] = [];
    const f = readFeatures({ TUNNEL_PUBLIC_URL: 'https://t.example/app' }, (line) => lines.push(line));
    assert.equal(f.publicUrl, undefined);
    assert.match(lines[0], /TUNNEL_PUBLIC_URL must look like https:\/\/tunnel\.example\.com/);
  });

  test('admin emails are trimmed and lowercased', () => {
    const f = readFeatures({
      TUNNEL_PUBLIC_URL: 'https://t.example',
      TUNNEL_ADMIN_EMAILS: ' Boss@Example.com, ops@example.com ,',
    });
    assert.deepEqual([...f.adminEmails], ['boss@example.com', 'ops@example.com']);
  });
});

describe('database migrations', () => {
  test('an old database gains the new columns and keeps its rows', async () => {
    const dir = tmp('old-db');
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(join(dir, 'relay.db'));
    old.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
      CREATE TABLE tunnels (id TEXT PRIMARY KEY, owner_device TEXT NOT NULL, owner_member TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE messages (tunnel_id TEXT NOT NULL, seq INTEGER NOT NULL, member_id TEXT NOT NULL,
        ct TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (tunnel_id, seq));
      CREATE TABLE files (id TEXT PRIMARY KEY, tunnel_id TEXT NOT NULL, member_id TEXT NOT NULL,
        size INTEGER NOT NULL, created INTEGER NOT NULL);
      INSERT INTO devices VALUES ('d_old', 'hash', 1000);
      INSERT INTO tunnels VALUES ('t_old', 'd_old', 'm_old', 1, 1000);
      INSERT INTO messages VALUES ('t_old', 1, 'm_old', 'ct', 1000);
      INSERT INTO files VALUES ('f_old', 't_old', 'm_old', 5, 1000);
    `);
    old.close();

    // Twice: migrations must be safe to run on every start.
    (await openStore(dir)).close();
    (await openStore(dir)).close();

    assert.deepEqual(await sql(dir, 'SELECT expires FROM messages'), [{ expires: 1000 + 7 * DAY }]);
    assert.deepEqual(await sql(dir, 'SELECT expires FROM files'), [{ expires: 1000 + 7 * DAY }]);
    assert.deepEqual(await sql(dir, 'SELECT id, account_id, seen FROM devices'), [
      { id: 'd_old', account_id: null, seen: null },
    ]);
    assert.equal((await sql(dir, 'SELECT COUNT(*) AS n FROM accounts'))[0].n, 0);
  });
});

describe('self-hosted relay', () => {
  test('without settings, the account, billing, stats and admin routes do not exist', async () => {
    const r = await relay();
    try {
      const routes = [
        ['GET', '/v1/auth/methods'],
        ['GET', '/v1/account'],
        ['POST', '/v1/auth/email'],
        ['GET', '/v1/auth/github/start'],
        ['POST', '/v1/auth/device'],
        ['GET', '/v1/devices/me'],
        ['POST', '/v1/billing/webhook'],
        ['POST', '/v1/hit'],
        ['GET', '/internal/install?f=/install.sh'],
        ['GET', '/v1/admin/stats'],
      ];
      for (const [method, path] of routes) {
        const res = await fetch(r.url + path, { method });
        assert.equal(res.status, 404, `${method} ${path}`);
      }
    } finally {
      await r.close();
    }
  });

  test('a bad percent escape in a path is a plain 404, not a relay error', async () => {
    const r = await relay();
    try {
      for (const [method, path] of [
        ['GET', '/v1/invites/%zz'],
        ['POST', '/v1/invites/%zz/claim'],
        ['DELETE', '/v1/tunnels/%zz'],
        ['GET', '/v1/tunnels/t%/files/%zz'],
        ['POST', '/v1/admin/accounts/%zz/plan'],
      ]) {
        const res = await fetch(r.url + path, { method });
        assert.equal(res.status, 404, `${method} ${path}`);
        assert.deepEqual(await res.json(), { error: 'Not found.' }, `${method} ${path}`);
      }
    } finally {
      await r.close();
    }
  });

  test('a device records when it was last seen', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'seen');
      assert.equal((await a.run('open', 'x')).code, 0);
      const [row] = await sql(r.dataDir, 'SELECT seen FROM devices WHERE id = ?', a.deviceId());
      assert.equal(typeof row.seen, 'number');
    } finally {
      await r.close();
    }
  });
});
