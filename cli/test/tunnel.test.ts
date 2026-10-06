import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveInviteKeys, newKey, open, seal } from '../src/crypto.js';
import { parseCode, randomSecret } from '../src/codes.js';
import { startRelay, type Relay } from '../src/relay/server.js';
import { run } from '../src/cli.js';

const tmp = (label: string) => mkdtempSync(join(tmpdir(), `tunnel-${label}-`));

function agent(relay: () => Relay, label: string) {
  const home = tmp(label);
  const cwd = tmp(`${label}-cwd`);
  return {
    home,
    cwd,
    async run(...argv: string[]) {
      let out = '';
      let err = '';
      const code = await run(argv, {
        env: { TUNNEL_HOME: home, TUNNEL_RELAY: relay().url },
        cwd,
        out: (s) => (out += s + '\n'),
        err: (s) => (err += s + '\n'),
      });
      return { code, out, err };
    },
  };
}

describe('crypto', () => {
  test('seal/open round-trips and rejects tampering', () => {
    const key = newKey();
    const sealed = seal(key, Buffer.from('hello'));
    assert.equal(open(key, sealed).toString(), 'hello');
    sealed[sealed.length - 1] ^= 1;
    assert.throws(() => open(key, sealed));
    assert.throws(() => open(newKey(), seal(key, Buffer.from('x'))));
  });

  test('invite keys depend on the secret', () => {
    const salt = Buffer.alloc(16, 7);
    const a = deriveInviteKeys('orange-fox-tide', salt);
    const b = deriveInviteKeys('ORANGE-fox-tide', salt);
    const c = deriveInviteKeys('orange-fox-river', salt);
    assert.equal(a.verifier, b.verifier);
    assert.notEqual(a.verifier, c.verifier);
  });
});

describe('invite codes', () => {
  test('parses codes and normalises spacing and case', () => {
    assert.deepEqual(parseCode(' 7-Orange-fox-tide '), { slot: 7, secret: 'orange-fox-tide' });
    assert.deepEqual(parseCode('7 orange fox tide'), { slot: 7, secret: 'orange-fox-tide' });
    assert.equal(randomSecret().split('-').length, 3);
  });

  test('rejects malformed codes with a readable message', () => {
    assert.throws(() => parseCode('orange-fox-tide'), /not an invite code/);
    assert.throws(() => parseCode('7-orange-fox'), /not an invite code/);
    assert.throws(() => parseCode('7-orange-fox-blorp'), /"blorp" is not a word/);
  });
});

describe('two agents on two machines', () => {
  let relay: Relay;
  let dataDir: string;
  before(async () => {
    dataDir = tmp('relay');
    relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir });
  });
  after(() => relay.close());

  const laptop = agent(() => relay, 'laptop');
  const server = agent(() => relay, 'server');
  const third = agent(() => relay, 'third');
  let code = '';

  test('open prints a one-time invite code', async () => {
    const r = await laptop.run('open', 'api-work', '--as', 'claude@laptop');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Tunnel api-work is open\./);
    const match = /Invite code: (\d+-[a-z]+-[a-z]+-[a-z]+)/.exec(r.out);
    assert.ok(match, r.out);
    code = match[1];
    assert.match(r.out, new RegExp(`tunnel join ${code}`));
  });

  test('join with the code, named with a short --as', async () => {
    const r = await server.run('join', code, '--as', 'codex');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Joined api-work as codex@/);
    assert.match(r.out, /claude@laptop/);
  });

  test('the same code cannot be used twice', async () => {
    const r = await third.run('join', code);
    assert.equal(r.code, 1);
    assert.match(r.err, /expired or was already used/);
  });

  test('send a message with a file; the peer reads it once', async () => {
    const file = join(laptop.cwd, 'api.json');
    writeFileSync(file, JSON.stringify({ users: '/v1/users' }));
    const sent = await laptop.run('send', 'Schema is ready', '--file', file);
    assert.equal(sent.code, 0, sent.err);
    assert.match(sent.out, /Sent to codex@/);

    const inbox = await server.run('inbox');
    assert.equal(inbox.code, 0, inbox.err);
    assert.match(inbox.out, /\[tunnel api-work\] claude@laptop \(peer agent\):\nSchema is ready/);
    const fileId = /tunnel get (f_\w+)/.exec(inbox.out)?.[1];
    assert.ok(fileId, inbox.out);

    const again = await server.run('inbox');
    assert.match(again.out, /No new messages/);

    const got = await server.run('get', fileId);
    assert.equal(got.code, 0, got.err);
    assert.equal(readFileSync(join(server.cwd, 'api.json'), 'utf8'), '{"users":"/v1/users"}');
  });

  test('wait blocks until a reply arrives', async () => {
    const waiting = laptop.run('wait', '--timeout', '10');
    await new Promise((r) => setTimeout(r, 300));
    const reply = await server.run('send', 'Got it. Generating client types.', '--to', 'claude');
    assert.equal(reply.code, 0, reply.err);
    const r = await waiting;
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Got it\. Generating client types\./);
    assert.match(r.out, /\(peer agent, to claude\)/);
  });

  test('wait gives up after the timeout', async () => {
    const r = await laptop.run('wait', '--timeout', '1');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /No new messages after 1s/);
  });

  test('messages addressed to someone else are skipped', async () => {
    const invite = await laptop.run('invite');
    const third_code = /Invite code: (\S+)/.exec(invite.out)?.[1];
    assert.ok(third_code, invite.out);
    assert.equal((await third.run('join', third_code, '--as', 'gemini@box')).code, 0);
    await third.run('inbox'); // drain history

    await laptop.run('send', 'Only for codex', '--to', 'codex');
    assert.match((await third.run('inbox')).out, /No new messages/);
    assert.match((await server.run('inbox')).out, /Only for codex/);
  });

  test('peers lists everyone, marking you', async () => {
    const r = await server.run('peers');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /claude@laptop/);
    assert.match(r.out, /codex@\S+ \(you\)/);
    assert.match(r.out, /gemini@box/);
  });

  test('the relay never stores names, keys or message text', () => {
    // WAL mode keeps recent writes in relay.db-wal, so check every database file.
    const db = Buffer.concat(
      readdirSync(dataDir)
        .filter((f) => f.startsWith('relay.db'))
        .map((f) => readFileSync(join(dataDir, f))),
    );
    assert.ok(db.includes(Buffer.from('t_')), 'sanity: tunnel ids should be visible to the relay');
    for (const secret of ['Schema is ready', 'api-work', 'claude@laptop', 'Only for codex', '/v1/users']) {
      assert.equal(db.includes(Buffer.from(secret)), false, `relay.db contains "${secret}"`);
    }
    for (const f of readdirSync(join(dataDir, 'files'))) {
      assert.equal(readFileSync(join(dataDir, 'files', f)).includes(Buffer.from('/v1/users')), false);
    }
    const key = JSON.parse(readFileSync(join(laptop.home, 'tunnels.json'), 'utf8'))['api-work'].key;
    assert.equal(db.includes(Buffer.from(key)), false);
  });

  test('only the opener can close; others leave', async () => {
    const r = await server.run('close');
    assert.equal(r.code, 1);
    assert.match(r.err, /Only the agent that opened/);
    assert.equal((await third.run('leave')).code, 0);
    const closed = await laptop.run('close');
    assert.equal(closed.code, 0, closed.err);
    const after = await server.run('inbox');
    assert.equal(after.code, 1);
    assert.match(after.err, /not found|no longer a member/);
  });
});

describe('invite guessing', () => {
  test('three wrong guesses cancel the invite', async () => {
    const relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: tmp('relay2') });
    try {
      const a = agent(() => relay, 'a');
      const b = agent(() => relay, 'b');
      const opened = await a.run('open', 'x');
      const real = /Invite code: (\S+)/.exec(opened.out)![1];
      const slot = real.split('-')[0];
      const wrong = `${slot}-zebra-zebra-zebra`;
      assert.match((await b.run('join', wrong)).err, /Wrong invite code/);
      assert.match((await b.run('join', wrong)).err, /Wrong invite code/);
      assert.match((await b.run('join', wrong)).err, /cancelled/);
      assert.match((await b.run('join', real)).err, /expired or was already used/);
    } finally {
      await relay.close();
    }
  });
});

describe('hosted quota', () => {
  test('a relay can cap tunnels per device', async () => {
    const relay = await startRelay({ port: 0, host: '127.0.0.1', dataDir: tmp('relay3'), maxTunnelsPerDevice: 1 });
    try {
      const a = agent(() => relay, 'quota');
      assert.equal((await a.run('open', 'one')).code, 0);
      const second = await a.run('open', 'two');
      assert.equal(second.code, 1);
      assert.match(second.err, /allows 1 open tunnel per device/);
      assert.equal(existsSync(join(a.home, 'tunnels.json')), true);
    } finally {
      await relay.close();
    }
  });
});

describe('skills', () => {
  test('install writes SKILL.md for Claude Code and Codex', async () => {
    const home = tmp('skills');
    let out = '';
    const code = await run(['skills', 'install'], {
      env: { TUNNEL_HOME: tmp('skills-state'), TUNNEL_SKILLS_HOME: home },
      out: (s) => (out += s + '\n'),
      err: () => {},
    });
    assert.equal(code, 0);
    for (const dir of [join(home, '.claude', 'skills', 'tunnel'), join(home, '.agents', 'skills', 'tunnel')]) {
      const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      assert.match(skill, /^---\nname: tunnel\ndescription: /);
    }
    assert.match(out, /Installed for Claude Code/);
    assert.match(out, /Installed for Codex/);
  });
});

describe('relay reset', () => {
  test('open re-registers when the relay no longer knows this device', async () => {
    const a = { relay: await startRelay({ port: 0, host: '127.0.0.1', dataDir: tmp('relay4') }) };
    const user = agent(() => a.relay, 'reset');
    try {
      assert.equal((await user.run('open', 'first')).code, 0);
      const port = Number(new URL(a.relay.url).port);
      await a.relay.close();
      // same URL, empty database: the saved device token is now unknown
      a.relay = await startRelay({ port, host: '127.0.0.1', dataDir: tmp('relay5') });
      const r = await user.run('open', 'second');
      assert.equal(r.code, 0, r.err);
    } finally {
      await a.relay.close();
    }
  });
});
