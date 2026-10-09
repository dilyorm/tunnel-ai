import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GB, MB } from '../src/relay/plans.js';
import { DAY, FULL_ENV, agent, grant, relay, sleep, sql, type Agent, type TestRelay } from './helpers.js';

function bigFile(dir: string, bytes: number) {
  const path = join(dir, `big-${bytes}.bin`);
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

const count = async (r: TestRelay, table: string) => (await sql(r.dataDir, `SELECT COUNT(*) AS n FROM ${table}`))[0].n;

describe('tunnel caps', () => {
  test('the Free cap counts this machine, and a relay without billing does not mention upgrades', async () => {
    const r = await relay({ maxTunnelsPerDevice: 1 });
    try {
      const a = agent(() => r, 'cap-free');
      assert.equal((await a.run('open', 'one')).code, 0);
      const second = await a.run('open', 'two');
      assert.equal(second.code, 1);
      assert.match(second.err, /The Free plan allows 1 open tunnel per device\. Close one with `tunnel close`\./);
      assert.doesNotMatch(second.err, /upgrade/);
    } finally {
      await r.close();
    }
  });

  test('a relay that sells plans points at tunnel upgrade', async () => {
    const r = await relay({ maxTunnelsPerDevice: 1, env: FULL_ENV });
    try {
      const a = agent(() => r, 'cap-hint');
      assert.equal((await a.run('open', 'one')).code, 0);
      const second = await a.run('open', 'two');
      assert.equal(second.code, 1);
      assert.match(second.err, /Run `tunnel upgrade` for 10 or 20 tunnels\./);
    } finally {
      await r.close();
    }
  });

  test('Plus allows 10 tunnels across every machine on the account', async () => {
    const r = await relay({ maxTunnelsPerDevice: 1, env: FULL_ENV });
    try {
      const a = agent(() => r, 'cap-plus-a');
      const b = agent(() => r, 'cap-plus-b');
      assert.equal((await a.run('open', 'a0')).code, 0);
      assert.equal((await b.run('open', 'b0')).code, 0);
      await grant(r.dataDir, 'plus', a.deviceId(), b.deviceId());
      for (let i = 1; i < 5; i++) {
        assert.equal((await a.run('open', `a${i}`)).code, 0);
        assert.equal((await b.run('open', `b${i}`)).code, 0);
      }
      const eleventh = await b.run('open', 'b5');
      assert.equal(eleventh.code, 1);
      assert.match(eleventh.err, /The Plus plan allows 10 open tunnels per account\./);
      assert.match(eleventh.err, /Pro allows 20: switch plans from Manage billing on your account page\./);
    } finally {
      await r.close();
    }
  });
});

describe('file limits', () => {
  test('a Free tunnel refuses an 11 MB file before reading it', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'file-free');
      assert.equal((await a.run('open', 'f')).code, 0);
      const sent = await a.run('send', 'big one', '--file', bigFile(a.cwd, 11 * MB));
      assert.equal(sent.code, 1);
      assert.match(sent.err, /This file is 11 MB\. Tunnels on the Free plan take files up to 10 MB\./);
      assert.deepEqual(readdirSync(join(r.dataDir, 'files')), []);
    } finally {
      await r.close();
    }
  });

  test('a Pro tunnel takes an 11 MB file, and it downloads intact', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'file-pro');
      assert.equal((await a.run('open', 'f')).code, 0);
      await grant(r.dataDir, 'pro', a.deviceId());
      const path = bigFile(a.cwd, 11 * MB);
      const sent = await a.run('send', 'big one', '--file', path, '--json');
      assert.equal(sent.code, 0, sent.err);
      const [file] = JSON.parse(sent.out).files as { id: string }[];
      const copy = join(a.cwd, 'copy.bin');
      const got = await a.run('get', file.id, '-o', copy);
      assert.equal(got.code, 0, got.err);
      assert.ok(readFileSync(copy).equals(readFileSync(path)));
    } finally {
      await r.close();
    }
  });

  test("the storage cap counts every file the owner's account keeps", async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'storage');
      assert.equal((await a.run('open', 's')).code, 0);
      await grant(r.dataDir, 'plus', a.deviceId());
      const now = Date.now();
      await sql(
        r.dataDir,
        "INSERT INTO files (id, tunnel_id, member_id, size, created, expires) VALUES ('f_fake', ?, 'm_fake', ?, ?, ?)",
        a.tunnel('s').id,
        2 * GB - 1024,
        now,
        now + DAY,
      );
      const small = join(a.cwd, 'small.txt');
      writeFileSync(small, 'x'.repeat(4096));
      const sent = await a.run('send', 'one more', '--file', small);
      assert.equal(sent.code, 1);
      assert.match(sent.err, /past its 2 GB of file storage/);
    } finally {
      await r.close();
    }
  });
});

describe('history', () => {
  test('messages expire on the owner plan: 7 days on Free, 30 on Plus', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'history');
      assert.equal((await a.run('open', 'h')).code, 0);
      assert.equal((await a.run('send', 'on free')).code, 0);
      await grant(r.dataDir, 'plus', a.deviceId());
      assert.equal((await a.run('send', 'on plus')).code, 0);
      const rows = await sql(r.dataDir, 'SELECT expires - created AS keep FROM messages ORDER BY seq');
      assert.deepEqual(
        rows.map((row) => row.keep),
        [7 * DAY, 30 * DAY],
      );
    } finally {
      await r.close();
    }
  });

  test('a downgrade keeps the tunnels already open; only new ones follow the Free cap', async () => {
    const r = await relay({ maxTunnelsPerDevice: 1 });
    try {
      const a = agent(() => r, 'downgrade');
      assert.equal((await a.run('open', 'first')).code, 0);
      const account = await grant(r.dataDir, 'plus', a.deviceId());
      assert.equal((await a.run('open', 'second')).code, 0);
      assert.equal((await a.run('open', 'third')).code, 0);
      await sql(r.dataDir, "UPDATE accounts SET plan = 'free', plan_source = NULL WHERE id = ?", account);
      for (const name of ['first', 'second', 'third']) {
        assert.equal((await a.run('send', 'still here', '-t', name)).code, 0);
      }
      const fourth = await a.run('open', 'fourth');
      assert.equal(fourth.code, 1);
      assert.match(fourth.err, /The Free plan allows 1 open tunnel per device/);
    } finally {
      await r.close();
    }
  });

  test('the sweep deletes expired messages and files, including the bytes on disk', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'sweep');
      assert.equal((await a.run('open', 'w')).code, 0);
      const note = join(a.cwd, 'note.txt');
      writeFileSync(note, 'bye');
      assert.equal((await a.run('send', 'old news', '--file', note)).code, 0);
      assert.equal(readdirSync(join(r.dataDir, 'files')).length, 1);
      await sql(r.dataDir, 'UPDATE messages SET expires = 1');
      await sql(r.dataDir, 'UPDATE files SET expires = 1');
      await r.sweep();
      assert.equal(await count(r, 'messages'), 0);
      assert.equal(await count(r, 'files'), 0);
      assert.deepEqual(readdirSync(join(r.dataDir, 'files')), []);
    } finally {
      await r.close();
    }
  });
});

describe('streamed uploads', () => {
  /** A request body of `chunks` pieces of `size` bytes, `gapMs` apart, sent without a Content-Length. */
  function trickle(chunks: number, size: number, gapMs: number) {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === chunks) return controller.close();
        if (gapMs) await sleep(gapMs);
        controller.enqueue(new Uint8Array(size).fill(sent % 251));
        sent++;
      },
    });
  }

  function upload(r: TestRelay, a: Agent, body: ReadableStream<Uint8Array>) {
    const rec = a.tunnel('up');
    return fetch(`${r.url}/v1/tunnels/${rec.id}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rec.memberToken}`, 'content-type': 'application/octet-stream' },
      body,
      duplex: 'half',
    } as RequestInit);
  }

  test('a slow chunked upload is saved whole and downloads the same', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'slow');
      assert.equal((await a.run('open', 'up')).code, 0);
      const res = await upload(r, a, trickle(8, 64 * 1024, 150));
      assert.equal(res.status, 201);
      const { fileId, size } = (await res.json()) as { fileId: string; size: number };
      assert.equal(size, 8 * 64 * 1024);
      const rec = a.tunnel('up');
      const down = await fetch(`${r.url}/v1/tunnels/${rec.id}/files/${fileId}`, {
        headers: { authorization: `Bearer ${rec.memberToken}` },
      });
      assert.equal(down.status, 200);
      assert.equal(down.headers.get('content-length'), String(size));
      const bytes = Buffer.from(await down.arrayBuffer());
      assert.equal(bytes.length, size);
      for (let i = 0; i < 8; i++) assert.equal(bytes[i * 64 * 1024], i % 251);
    } finally {
      await r.close();
    }
  });

  test('an over-limit chunked upload gets 413 and leaves no file behind', async () => {
    const r = await relay();
    try {
      const a = agent(() => r, 'over');
      assert.equal((await a.run('open', 'up')).code, 0);
      const res = await upload(r, a, trickle(11, MB, 0));
      assert.equal(res.status, 413);
      const { error } = (await res.json()) as { error: string };
      assert.match(error, /This file is over 10 MB\. Tunnels on the Free plan take files up to 10 MB\./);
      assert.deepEqual(readdirSync(join(r.dataDir, 'files')), []);
      assert.equal(await count(r, 'files'), 0);
    } finally {
      await r.close();
    }
  });
});
