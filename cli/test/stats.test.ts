import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayOf, installMetric } from '../src/relay/stats.js';
import { DAY, FULL_ENV, PUBLIC_URL, agent, relay, sql, type TestRelay } from './helpers.js';

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

async function today(r: TestRelay): Promise<Record<string, number>> {
  const rows = await sql(r.dataDir, 'SELECT metric, n FROM stats_daily WHERE day = ?', dayOf());
  return Object.fromEntries(rows.map((row) => [row.metric, row.n]));
}

const hit = (r: TestRelay, userAgent: string, referrer = '') =>
  fetch(`${r.url}/v1/hit`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'user-agent': userAgent },
    body: JSON.stringify({ p: '/', r: referrer }),
  }).then((res) => res.status);

const inviteCode = (out: string) => /Invite code: (\S+)/.exec(out)![1];

describe('relay activity', () => {
  test('devices, tunnels, joins, messages and files are counted per day', async () => {
    const r = await relay({ env: FULL_ENV });
    try {
      const a = agent(() => r, 'count-a');
      const b = agent(() => r, 'count-b');
      const code = inviteCode((await a.run('open', 'c')).out);
      assert.equal((await b.run('join', code)).code, 0);
      const note = join(a.cwd, 'note.txt');
      writeFileSync(note, 'hello');
      assert.equal((await a.run('send', 'one', '--file', note)).code, 0);
      assert.equal((await b.run('send', 'two')).code, 0);
      const n = await today(r);
      assert.equal(n.devices_created, 1); // joining needs no device
      assert.equal(n.tunnels_opened, 1);
      assert.equal(n.joins, 1);
      assert.equal(n.messages, 2);
      assert.equal(n.files, 1);
      assert.ok(n.file_bytes > 5, 'sealed bytes are counted');
    } finally {
      await r.close();
    }
  });

  test('each agent and each machine counts once a day, however much it talks', async () => {
    const r = await relay({ env: FULL_ENV });
    try {
      const a = agent(() => r, 'active-a');
      const b = agent(() => r, 'active-b');
      const code = inviteCode((await a.run('open', 'c')).out);
      assert.equal((await b.run('join', code)).code, 0);
      for (let i = 0; i < 3; i++) assert.equal((await a.run('send', `ping ${i}`)).code, 0);
      assert.equal((await b.run('inbox')).code, 0);
      assert.equal((await a.run('open', 'second')).code, 0);
      const day = dayOf();
      // One machine (a's), three agents: a and b in "c", and a again in "second".
      assert.deepEqual(await sql(r.dataDir, 'SELECT COUNT(*) AS n FROM active_devices WHERE day = ?', day), [{ n: 1 }]);
      assert.deepEqual(await sql(r.dataDir, 'SELECT COUNT(*) AS n FROM active_members WHERE day = ?', day), [{ n: 3 }]);
    } finally {
      await r.close();
    }
  });
});

describe('landing page beacon', () => {
  test('views and unique visitors are counted, bots are not, and no address is stored', async () => {
    const r = await relay({ env: FULL_ENV });
    try {
      assert.equal(await hit(r, BROWSER, 'https://news.ycombinator.com/item?id=1'), 204);
      assert.equal(await hit(r, BROWSER, `${PUBLIC_URL}/terms`), 204);
      assert.equal(await hit(r, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 204);
      assert.equal(await hit(r, 'Mozilla/5.0 HeadlessChrome/120.0'), 204);
      const n = await today(r);
      assert.equal(n.page_views, 2);
      assert.equal(n.unique_visitors, 1);
      assert.deepEqual(await sql(r.dataDir, 'SELECT host, n FROM referrers'), [{ host: 'news.ycombinator.com', n: 1 }]);
      const visitors = await sql(r.dataDir, 'SELECT * FROM visitors');
      assert.equal(visitors.length, 1);
      assert.match(visitors[0].hash, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(visitors), /127\.0\.0\.1/);
    } finally {
      await r.close();
    }
  });

  test("the sweep deletes yesterday's visitor hashes; the counts stay", async () => {
    const r = await relay({ env: FULL_ENV });
    try {
      assert.equal(await hit(r, BROWSER), 204);
      await sql(r.dataDir, "INSERT INTO visitors (day, hash) VALUES (?, 'old')", dayOf(Date.now() - DAY));
      await r.sweep();
      assert.deepEqual(await sql(r.dataDir, 'SELECT day FROM visitors'), [{ day: dayOf() }]);
      assert.equal((await today(r)).unique_visitors, 1);
    } finally {
      await r.close();
    }
  });

  test('without a salt, views are counted but visitors are not', async () => {
    const r = await relay({ env: { ...FULL_ENV, TUNNEL_STATS_SALT: '' } });
    try {
      assert.equal(await hit(r, BROWSER), 204);
      const n = await today(r);
      assert.equal(n.page_views, 1);
      assert.equal(n.unique_visitors, undefined);
      assert.deepEqual(await sql(r.dataDir, 'SELECT * FROM visitors'), []);
    } finally {
      await r.close();
    }
  });

  test('a relay without an admin keeps no stats', async () => {
    const r = await relay({ env: { TUNNEL_PUBLIC_URL: PUBLIC_URL } });
    try {
      assert.equal(await hit(r, BROWSER), 404);
      const a = agent(() => r, 'no-stats');
      assert.equal((await a.run('open', 'x')).code, 0);
      assert.deepEqual(await sql(r.dataDir, 'SELECT * FROM stats_daily'), []);
      assert.deepEqual(await sql(r.dataDir, 'SELECT * FROM active_devices'), []);
    } finally {
      await r.close();
    }
  });
});

describe('installs', () => {
  test('install downloads are counted by file, and the tarball only when npm fetches it', async () => {
    const r = await relay({ env: FULL_ENV });
    try {
      const count = (f: string, userAgent: string) =>
        fetch(`${r.url}/internal/install?f=${encodeURIComponent(f)}`, { headers: { 'user-agent': userAgent } }).then(
          (res) => res.status,
        );
      assert.equal(await count('/install.sh', 'curl/8.5.0'), 204);
      assert.equal(await count('/install.ps1', 'Mozilla/5.0 (Windows NT 10.0) WindowsPowerShell/5.1'), 204);
      assert.equal(await count('/tunnel-ai.tgz', 'npm/10.8.2 node/v22.21.0 win32 x64'), 204);
      assert.equal(await count('/tunnel-ai-0.1.0.tgz?x=1', 'npm/10.8.2 node/v22.21.0 linux x64'), 204);
      assert.equal(await count('/tunnel-ai.tgz', 'curl/8.5.0'), 204); // the installer's own download
      assert.equal(await count('/index.html', 'curl/8.5.0'), 204);
      const n = await today(r);
      assert.equal(n.installs_sh, 1);
      assert.equal(n.installs_ps1, 1);
      assert.equal(n.installs_npm, 2);
    } finally {
      await r.close();
    }
  });

  test('installMetric reads the path and user agent nginx passes on', () => {
    assert.equal(installMetric('/install.sh', ''), 'installs_sh');
    assert.equal(installMetric('/tunnel-ai.tgz', 'curl/8.5.0'), undefined);
    assert.equal(installMetric('/tunnel-ai-0.2.0-beta.1.tgz', 'npm/11.0.0'), 'installs_npm');
    assert.equal(installMetric('/evil/tunnel-ai.tgz', 'npm/11.0.0'), undefined);
  });
});
