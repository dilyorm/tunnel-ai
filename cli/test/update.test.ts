import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { RelayClient, seenVersions } from '../src/relay-client.js';
import { updateHint } from '../src/update.js';
import { isNewer, VERSION } from '../src/version.js';
import { relay, tmp } from './helpers.js';

describe('versions', () => {
  test('the version is 0.2.0 in the code and in package.json', () => {
    assert.equal(VERSION, '0.2.0');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(pkg.version, VERSION);
  });

  test('isNewer compares x.y.z numerically and refuses anything else', () => {
    assert.equal(isNewer('0.2.0', '0.1.0'), true);
    assert.equal(isNewer('0.10.0', '0.9.9'), true);
    assert.equal(isNewer('1.0.0', '0.99.99'), true);
    assert.equal(isNewer('0.2.1', '0.2.0'), true);
    assert.equal(isNewer('0.2.0', '0.2.0'), false);
    assert.equal(isNewer('0.1.9', '0.2.0'), false);
    assert.equal(isNewer('0.3.0-beta', '0.2.0'), false);
    assert.equal(isNewer('', '0.2.0'), false);
    assert.equal(isNewer('0.3.0', 'garbage'), false);
  });
});

describe('relay version header', () => {
  test('every response carries x-tunnel-version, errors too', async () => {
    const r = await relay();
    try {
      const health = await fetch(`${r.url}/v1/health`);
      assert.equal(health.headers.get('x-tunnel-version'), VERSION);
      assert.deepEqual(await health.json(), { ok: true, version: VERSION });
      const missing = await fetch(`${r.url}/nope`);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get('x-tunnel-version'), VERSION);
    } finally {
      await r.close();
    }
  });

  test('a relay started with another version reports that one', async () => {
    const r = await relay({ version: '9.9.9' });
    try {
      const health = await fetch(`${r.url}/v1/health`);
      assert.equal(health.headers.get('x-tunnel-version'), '9.9.9');
      assert.deepEqual(await health.json(), { ok: true, version: '9.9.9' });
    } finally {
      await r.close();
    }
  });

  test('the client records the version each relay reported, from error answers too', async () => {
    const r = await relay({ version: '9.9.9' });
    try {
      seenVersions.clear();
      await assert.rejects(new RelayClient(r.url).json('GET', '/nope'));
      assert.equal(seenVersions.get(r.url), '9.9.9');
    } finally {
      await r.close();
    }
  });
});

const DAY = 24 * 60 * 60 * 1000;

describe('update hint rules', () => {
  const base = { command: 'send', seen: '9.9.9', current: '0.2.0', now: 10 * DAY, optOut: false };
  const LINE = 'tunnel 9.9.9 is out (you have 0.2.0). Run `tunnel update` to get it.';

  test('shows when the release relay is newer and no hint was shown yet', () => {
    assert.equal(updateHint(base), LINE);
  });

  test('once a day at most', () => {
    assert.equal(updateHint({ ...base, lastHintAt: base.now - 60 * 60 * 1000 }), undefined);
    assert.equal(updateHint({ ...base, lastHintAt: base.now - DAY - 1 }), LINE);
  });

  test('a garbage or future timestamp counts as stale', () => {
    assert.equal(updateHint({ ...base, lastHintAt: 'yesterday' }), LINE);
    assert.equal(updateHint({ ...base, lastHintAt: base.now + DAY }), LINE);
  });

  test('silent when not newer, not seen, opted out, or for update and relay', () => {
    assert.equal(updateHint({ ...base, seen: '0.2.0' }), undefined);
    assert.equal(updateHint({ ...base, seen: '0.1.0' }), undefined);
    assert.equal(updateHint({ ...base, seen: 'garbage' }), undefined);
    assert.equal(updateHint({ ...base, seen: undefined }), undefined);
    assert.equal(updateHint({ ...base, optOut: true }), undefined);
    assert.equal(updateHint({ ...base, command: 'update' }), undefined);
    assert.equal(updateHint({ ...base, command: 'relay' }), undefined);
  });
});

describe('update hint in the CLI', () => {
  const HINT = `tunnel 9.9.9 is out (you have ${VERSION}). Run \`tunnel update\` to get it.\n`;

  /** A machine with its own ~/.tunnel, talking to relay r. */
  function machine(r: { url: string }, extra: Record<string, string> = {}) {
    const home = tmp('hint');
    const cwd = tmp('hint-cwd');
    return {
      home,
      async run(...argv: string[]) {
        let out = '';
        let err = '';
        const code = await run(argv, {
          env: { TUNNEL_HOME: home, TUNNEL_RELAY: r.url, ...extra },
          cwd,
          out: (s) => (out += s + '\n'),
          err: (s) => (err += s + '\n'),
        });
        return { code, out, err };
      },
      config: () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Record<string, unknown>,
      setHintAt(at: unknown) {
        const file = join(home, 'config.json');
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), updateHintAt: at }));
      },
    };
  }
  const count = (text: string, part: string) => text.split(part).length - 1;

  test('after a command, once a day, on stderr only', async () => {
    const r = await relay({ version: '9.9.9' });
    try {
      const m = machine(r, { TUNNEL_DOWNLOAD: r.url });
      const first = await m.run('open', 'hint');
      assert.equal(first.code, 0, first.err);
      assert.ok(first.err.endsWith(HINT), first.err);
      assert.equal(count(first.err, 'is out'), 1);
      assert.equal(typeof m.config().updateHintAt, 'number');

      const again = await m.run('peers', '--json');
      assert.equal(again.code, 0, again.err);
      assert.equal(count(again.err, 'is out'), 0);

      m.setHintAt(Date.now() - DAY - 1000);
      const nextDay = await m.run('peers', '--json');
      assert.equal(nextDay.code, 0, nextDay.err);
      assert.ok(nextDay.err.endsWith(HINT));
      assert.ok(Array.isArray(JSON.parse(nextDay.out)), 'stdout stays one JSON document');
    } finally {
      await r.close();
    }
  });

  test('after a failed command too, below its error', async () => {
    const r = await relay({ version: '9.9.9' });
    try {
      const m = machine(r, { TUNNEL_DOWNLOAD: r.url });
      const res = await m.run('join', '99999-orange-fox-tide');
      assert.notEqual(res.code, 0);
      assert.ok(res.err.endsWith(HINT), res.err);
      assert.ok(res.err.length > HINT.length, 'the error comes first');
    } finally {
      await r.close();
    }
  });

  test('silent for a self-hosted relay, with TUNNEL_NO_UPDATE_CHECK=1, and when the relay is not newer', async () => {
    const newer = await relay({ version: '9.9.9' });
    const same = await relay();
    try {
      const selfHosted = await machine(newer).run('open', 'a');
      assert.equal(count(selfHosted.err, 'is out'), 0);
      const optedOut = await machine(newer, { TUNNEL_DOWNLOAD: newer.url, TUNNEL_NO_UPDATE_CHECK: '1' }).run('open', 'b');
      assert.equal(count(optedOut.err, 'is out'), 0);
      const current = await machine(same, { TUNNEL_DOWNLOAD: same.url }).run('open', 'c');
      assert.equal(count(current.err, 'is out'), 0);
    } finally {
      await newer.close();
      await same.close();
    }
  });
});
