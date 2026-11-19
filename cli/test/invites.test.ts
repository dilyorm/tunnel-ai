import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveInviteKeys } from '../src/crypto.js';
import { parseCode, randomSecret } from '../src/codes.js';
import { LIMITS } from '../src/relay/server.js';
import { ADMIN, FULL_ENV, agent, browser, outbound, relay, signIn, sql, type TestRelay } from './helpers.js';

const codeOf = (out: string) => /Invite code: (\S+)/.exec(out)?.[1] ?? assert.fail(`no code in: ${out}`);

describe('always-on invite codes', () => {
  test('codes have four words and still parse', () => {
    assert.equal(randomSecret(4).split('-').length, 4);
    assert.deepEqual(parseCode('12-Orange-fox-tide-moon'), { slot: 12, secret: 'orange-fox-tide-moon' });
    assert.throws(() => parseCode('12-orange-fox-tide-moon-sun'), /not an invite code/);
  });

  let r: TestRelay;
  before(async () => {
    r = await relay();
  });
  after(() => r.close());

  test('never expire, let any number of agents join, and survive wrong guesses', async () => {
    const owner = agent(() => r, 'perm-owner');
    assert.equal((await owner.run('open', 'team')).code, 0);
    const made = await owner.run('invite', '--permanent');
    assert.equal(made.code, 0, made.err);
    assert.match(made.out, /Always on/);
    const code = codeOf(made.out);
    assert.equal(code.split('-').length, 5);
    const slot = Number(code.split('-')[0]);

    const row = (await sql(r.dataDir, 'SELECT permanent, expires FROM invites WHERE slot = ?', slot))[0];
    assert.equal(row.permanent, 1);
    assert.ok(row.expires > Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    // The sweep leaves it alone.
    await r.sweep();

    // Wrong guesses don't cancel it, unlike a one-time invite.
    const guesser = agent(() => r, 'perm-guess');
    for (let i = 0; i < LIMITS.inviteAttempts + 2; i++) {
      assert.match((await guesser.run('join', `${slot}-zebra-zebra-zebra-zebra`)).err, /Wrong invite code/);
    }

    for (const name of ['perm-a', 'perm-b', 'perm-c']) {
      const joined = await agent(() => r, name).run('join', code);
      assert.equal(joined.code, 0, joined.err);
    }
    const peers = await owner.run('peers');
    assert.equal(peers.out.trim().split('\n').length >= 4, true, peers.out);

    const listed = await owner.run('invites', '--json');
    const { invites } = JSON.parse(listed.out);
    assert.equal(invites.length, 1);
    assert.equal(invites[0].slot, slot);
    assert.equal(invites[0].uses, 3);
    assert.equal(invites[0].code, code, 'the maker sees its own code again');
    assert.ok(invites[0].lastUsed > 0);
  });

  test('a one-time invite still works once', async () => {
    const owner = agent(() => r, 'once-owner');
    const opened = await owner.run('open', 'once');
    const code = codeOf(opened.out);
    assert.equal(code.split('-').length, 4);
    assert.equal((await agent(() => r, 'once-a').run('join', code)).code, 0);
    assert.match((await agent(() => r, 'once-b').run('join', code)).err, /expired or was already used/);
    assert.match((await owner.run('invites')).out, /no always-on invites/);
  });

  test('revoke: by the maker or the opener only, and joins stop at once', async () => {
    const owner = agent(() => r, 'rv-owner');
    const opened = await owner.run('open', 'rv');
    const guest = agent(() => r, 'rv-guest');
    assert.equal((await guest.run('join', codeOf(opened.out))).code, 0);

    const code = codeOf((await owner.run('invite', '--permanent')).out);
    const slot = code.split('-')[0];
    const theirs = codeOf((await guest.run('invite', '--permanent')).out);
    const theirSlot = theirs.split('-')[0];

    // The guest sees both, but only its own code in full.
    const seen = await guest.run('invites');
    assert.match(seen.out, new RegExp(theirs));
    assert.match(seen.out, new RegExp(`${slot}-… +\\(made on another machine`));

    const denied = await guest.run('invite', '--revoke', slot);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /Only the agent that made this invite/);

    // The opener may revoke anyone's.
    const revoked = await owner.run('invite', '--revoke', theirs);
    assert.equal(revoked.code, 0, revoked.err);
    assert.match(revoked.out, new RegExp(`Revoked always-on invite ${theirSlot}`));
    assert.match((await agent(() => r, 'rv-late').run('join', theirs)).err, /expired or was already used/);

    // The guest's stale local copy is dropped on the next listing.
    const after = JSON.parse((await guest.run('invites', '--json')).out);
    assert.deepEqual(after.invites.map((i: { slot: number }) => String(i.slot)), [slot]);

    assert.equal((await owner.run('invite', '--revoke', slot)).code, 0);
    assert.match((await owner.run('invite', '--revoke', slot)).err, /no invite with that slot/);
    assert.match((await owner.run('invite', '--revoke', 'abc')).err, /takes the invite's slot/);
  });

  test("leaving revokes the always-on invites you made, not other people's", async () => {
    const owner = agent(() => r, 'lv-owner');
    const opened = await owner.run('open', 'lv');
    const guest = agent(() => r, 'lv-guest');
    assert.equal((await guest.run('join', codeOf(opened.out))).code, 0);
    const ownerCode = codeOf((await owner.run('invite', '--permanent')).out);
    const guestCode = codeOf((await guest.run('invite', '--permanent')).out);
    assert.equal((await guest.run('leave')).code, 0);
    assert.match((await agent(() => r, 'lv-late').run('join', guestCode)).err, /expired or was already used/);
    assert.equal((await agent(() => r, 'lv-ok').run('join', ownerCode)).code, 0);
  });

  test('a tunnel holds at most a few, and closing the tunnel removes them', async () => {
    const owner = agent(() => r, 'cap-owner');
    await owner.run('open', 'cap');
    for (let i = 0; i < LIMITS.permanentInvites; i++) {
      assert.equal((await owner.run('invite', '--permanent')).code, 0);
    }
    const over = await owner.run('invite', '--permanent');
    assert.equal(over.code, 1);
    assert.match(over.err, new RegExp(`already has ${LIMITS.permanentInvites} always-on invites`));
    const tid = (await sql(r.dataDir, 'SELECT tunnel_id FROM invites WHERE permanent = 1 ORDER BY created DESC'))[0]
      .tunnel_id;
    assert.equal((await owner.run('close')).code, 0);
    assert.equal((await sql(r.dataDir, 'SELECT COUNT(*) AS n FROM invites WHERE tunnel_id = ?', tid))[0].n, 0);
  });

  test('tries at always-on codes are limited per address', async () => {
    const fresh = await relay();
    try {
      const owner = agent(() => fresh, 'lim-owner');
      await owner.run('open', 'lim');
      const slot = codeOf((await owner.run('invite', '--permanent')).out).split('-')[0];
      const { salt } = (await (await fetch(`${fresh.url}/v1/invites/${slot}`)).json()) as { salt: string };
      const { verifier } = deriveInviteKeys('zebra-zebra-zebra-zebra', Buffer.from(salt, 'base64url'));
      const claim = () =>
        fetch(`${fresh.url}/v1/invites/${slot}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ verifier }),
        }).then((res) => res.status);
      for (let i = 0; i < LIMITS.permanentClaimsPerHour; i++) assert.equal(await claim(), 403);
      assert.equal(await claim(), 429);
      // Still there: the limit throttles, it never cancels.
      assert.equal((await fetch(`${fresh.url}/v1/invites/${slot}`)).status, 200);
    } finally {
      await fresh.close();
    }
  });
});

describe('always-on invites in the admin panel', () => {
  const out = outbound();
  const logs: string[] = [];
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch, log: (line) => logs.push(line) });
  });
  after(() => r.close());

  test('lists every always-on invite with its tunnel, counts tunnels, and revokes', async () => {
    const boss = browser(r);
    await signIn(boss, out, ADMIN);
    const owner = agent(() => r, 'adm-owner');
    await owner.run('open', 'adm');
    const code = codeOf((await owner.run('invite', '--permanent')).out);
    const slot = Number(code.split('-')[0]);
    await agent(() => r, 'adm-guest').run('join', code);

    const stats = (await boss.get('/v1/admin/stats')).body;
    assert.deepEqual(stats.tunnels, { open: 1, active7d: 1, alwaysOnInvites: 1 });

    const listed = await boss.get('/v1/admin/invites');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.invites.length, 1);
    const invite = listed.body.invites[0];
    assert.equal(invite.slot, slot);
    assert.equal(invite.uses, 1);
    assert.equal(invite.members, 2);
    assert.equal(invite.ownerEmail, null);
    assert.ok(!JSON.stringify(listed.body).includes(code.split('-')[1]), 'the relay never has the words');

    // Not for anyone else, and not from another site.
    const user = browser(r);
    await signIn(user, out, 'nosy@example.com');
    for (const b of [browser(r), user]) {
      assert.equal((await b.get('/v1/admin/invites')).status, 404);
      assert.equal((await b.request('DELETE', `/v1/admin/invites/${slot}`)).status, 404);
    }
    const evil = browser(r, 'https://evil.example');
    for (const [name, value] of boss.jar) evil.jar.set(name, value);
    assert.equal((await evil.request('DELETE', `/v1/admin/invites/${slot}`)).status, 403);

    const revoked = await boss.request('DELETE', `/v1/admin/invites/${slot}`);
    assert.equal(revoked.status, 204);
    assert.equal((await boss.request('DELETE', `/v1/admin/invites/${slot}`)).status, 404);
    assert.equal((await boss.get('/v1/admin/invites')).body.invites.length, 0);
    assert.ok(logs.some((line) => line.includes(`revoked always-on invite ${slot}`)));
    assert.match((await agent(() => r, 'adm-late').run('join', code)).err, /expired or was already used/);
  });
});
