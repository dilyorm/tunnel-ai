import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RelayClient, seenVersions } from '../src/relay-client.js';
import { isNewer, VERSION } from '../src/version.js';
import { relay } from './helpers.js';

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
