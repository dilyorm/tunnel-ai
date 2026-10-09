import { randomInt } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { secretToken, sha256, shortId } from '../crypto.js';
import type { Member } from './db.js';
import { HttpError, LIMITS, body, bearer, json, send, str } from './http.js';
import type { App } from './server.js';

// Devices, tunnels, invites, members, messages and files: the relay's original job. Everything stored
// here is ciphertext or an id. The relay never sees tunnel keys, names or message text.

export function tunnelRoutes(app: App, options: { ttlMs: number }) {
  const { store } = app;

  // ---------- long-poll wakeups ----------

  const waiters = new Map<string, Set<() => void>>();

  function wake(tunnelId: string) {
    const set = waiters.get(tunnelId);
    if (!set) return;
    waiters.delete(tunnelId);
    for (const fn of set) fn();
  }

  function waitForMessage(tunnelId: string, ms: number, res: ServerResponse) {
    return new Promise<void>((resolve) => {
      const set = waiters.get(tunnelId) ?? new Set<() => void>();
      waiters.set(tunnelId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        res.off('close', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      res.on('close', done);
    });
  }

  // Devices cost nothing to mint, so the per-device tunnel cap is only as strong as this limit.
  const limitDevices = app.counter(
    60 * 60_000,
    LIMITS.devicesPerHour,
    'Too many new devices from this address. Try again in an hour.',
  );

  // ---------- helpers ----------

  function member(req: IncomingMessage, tunnelId: string): Member {
    const row = store.memberByToken.get(sha256(bearer(req)));
    if (!row || row.tunnel_id !== tunnelId) {
      throw new HttpError(404, 'Tunnel not found, or you are no longer a member.');
    }
    const now = Date.now();
    if (now - row.seen > 30_000) store.touchMember.run(now, row.id);
    return row;
  }

  function freeSlot(): number {
    store.deleteExpiredInvites.run(Date.now());
    const used = new Set(store.usedSlots.all().map((r) => r.slot));
    const ceiling = used.size < 800 ? 999 : used.size < 8000 ? 9999 : 99999;
    for (let i = 0; i < 50; i++) {
      const slot = randomInt(1, ceiling + 1);
      if (!used.has(slot)) return slot;
    }
    throw new HttpError(503, 'No free invite slots right now. Try again in a minute.');
  }

  async function removeTunnel(tunnelId: string) {
    const files = store.tunnelFiles.all(tunnelId);
    store.deleteTunnel.run(tunnelId);
    await Promise.all(files.map((f) => unlink(join(app.filesDir, f.id)).catch(() => {})));
    wake(tunnelId);
  }

  // ---------- routes ----------

  app.on('POST', '/v1/devices', async (req, res) => {
    limitDevices(req);
    const id = shortId('d', 14);
    const token = secretToken();
    store.insertDevice.run(id, sha256(token), Date.now());
    send(res, 201, { deviceId: id, deviceToken: token });
  });

  app.on('POST', '/v1/tunnels', async (req, res) => {
    const deviceId = app.device(req).id;
    const input = await json<{ profile?: string }>(req);
    const max = app.maxTunnelsPerDevice;
    if (max > 0 && (store.countTunnels.get(deviceId)?.n ?? 0) >= max) {
      throw new HttpError(
        402,
        `This relay allows ${max} open tunnel${max === 1 ? '' : 's'} per device. ` +
          'Close one with `tunnel close`, or see https://tunnel.dilyor.dev/#pricing.',
      );
    }
    const now = Date.now();
    const tunnelId = shortId('t', 16);
    const memberId = shortId('m', 12);
    const token = secretToken();
    const profile = input.profile ? str(input.profile, 'profile', LIMITS.profileBytes) : null;
    store.insertTunnel.run(tunnelId, deviceId, memberId, now);
    store.insertMember.run(memberId, tunnelId, sha256(token), profile, now, now);
    send(res, 201, { tunnelId, memberId, memberToken: token });
  });

  app.on('DELETE', '/v1/tunnels/:tid', async (req, res, [tid]) => {
    const me = member(req, tid);
    const tunnel = store.tunnel.get(tid);
    if (!tunnel) throw new HttpError(404, 'Tunnel not found.');
    if (tunnel.owner_member !== me.id) {
      throw new HttpError(403, 'Only the agent that opened this tunnel can close it. Use `tunnel leave` instead.');
    }
    await removeTunnel(tid);
    send(res, 204);
  });

  app.on('POST', '/v1/tunnels/:tid/invites', async (req, res, [tid]) => {
    member(req, tid);
    const input = await json<{ salt?: string; wrapped?: string; verifierHash?: string }>(req);
    const salt = str(input.salt, 'salt', 64);
    const wrapped = str(input.wrapped, 'wrapped', 4096);
    const verifierHash = str(input.verifierHash, 'verifierHash', 128);
    const slot = freeSlot();
    const expires = Date.now() + LIMITS.inviteTtlMs;
    store.insertInvite.run(slot, tid, salt, wrapped, verifierHash, expires);
    send(res, 201, { slot, expiresAt: expires });
  });

  app.on('GET', '/v1/invites/:slot', async (_req, res, [slot]) => {
    const invite = store.invite.get(Number(slot), Date.now());
    if (!invite) throw new HttpError(404, 'That invite code has expired or was already used.');
    send(res, 200, { salt: invite.salt });
  });

  app.on('POST', '/v1/invites/:slot/claim', async (req, res, [slot]) => {
    const input = await json<{ verifier?: string }>(req);
    const verifier = str(input.verifier, 'verifier', 128);
    const invite = store.invite.get(Number(slot), Date.now());
    if (!invite) throw new HttpError(404, 'That invite code has expired or was already used.');
    if (sha256(verifier) !== invite.verifier_hash) {
      const attempts = store.failInvite.get(invite.slot)?.attempts ?? LIMITS.inviteAttempts;
      if (attempts >= LIMITS.inviteAttempts) {
        store.deleteInvite.run(invite.slot);
        throw new HttpError(410, 'Wrong code too many times, so the invite was cancelled. Ask for a new one.');
      }
      throw new HttpError(403, 'Wrong invite code. Check the words and try again.');
    }
    store.deleteInvite.run(invite.slot);
    const now = Date.now();
    const memberId = shortId('m', 12);
    const token = secretToken();
    store.insertMember.run(memberId, invite.tunnel_id, sha256(token), null, now, now);
    send(res, 200, { tunnelId: invite.tunnel_id, wrapped: invite.wrapped, memberId, memberToken: token });
  });

  app.on('GET', '/v1/tunnels/:tid/members', async (req, res, [tid]) => {
    const me = member(req, tid);
    const tunnel = store.tunnel.get(tid);
    const members = store.members.all(tid).map((m) => ({
      id: m.id,
      profile: m.profile,
      seen: m.seen,
      you: m.id === me.id,
      owner: m.id === tunnel?.owner_member,
    }));
    send(res, 200, { members });
  });

  app.on('PUT', '/v1/tunnels/:tid/members/me', async (req, res, [tid]) => {
    const me = member(req, tid);
    const input = await json<{ profile?: string }>(req);
    store.setProfile.run(str(input.profile, 'profile', LIMITS.profileBytes), me.id);
    send(res, 204);
  });

  app.on('DELETE', '/v1/tunnels/:tid/members/me', async (req, res, [tid]) => {
    const me = member(req, tid);
    store.deleteMember.run(me.id);
    if ((store.countMembers.get(tid)?.n ?? 0) === 0) await removeTunnel(tid);
    send(res, 204);
  });

  app.on('POST', '/v1/tunnels/:tid/messages', async (req, res, [tid]) => {
    const me = member(req, tid);
    const input = await json<{ ct?: string }>(req);
    const ct = str(input.ct, 'ct', LIMITS.messageBytes);
    const row = store.bumpSeq.get(tid);
    if (!row) throw new HttpError(404, 'Tunnel not found.');
    store.insertMessage.run(tid, row.seq, me.id, ct, Date.now());
    wake(tid);
    send(res, 201, { seq: row.seq });
  });

  app.on('GET', '/v1/tunnels/:tid/messages', async (req, res, [tid], url) => {
    member(req, tid);
    const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const waitS = Math.min(LIMITS.maxWaitS, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));

    let rows = store.messagesAfter.all(tid, after, limit);
    if (rows.length === 0 && waitS > 0) {
      await waitForMessage(tid, waitS * 1000, res);
      if (res.destroyed) return;
      rows = store.messagesAfter.all(tid, after, limit);
    }
    const tunnel = store.tunnel.get(tid);
    if (!tunnel) throw new HttpError(404, 'This tunnel was closed.');
    send(res, 200, {
      messages: rows.map((r) => ({ seq: r.seq, from: r.member_id, ct: r.ct, at: r.created })),
      latest: tunnel.seq,
    });
  });

  app.on('POST', '/v1/tunnels/:tid/files', async (req, res, [tid]) => {
    const me = member(req, tid);
    const data = await body(req, LIMITS.fileBytes);
    if (data.length === 0) throw new HttpError(400, 'Empty file.');
    const id = shortId('f', 10);
    await writeFile(join(app.filesDir, id), data);
    store.insertFile.run(id, tid, me.id, data.length, Date.now());
    send(res, 201, { fileId: id, size: data.length });
  });

  app.on('GET', '/v1/tunnels/:tid/files/:fid', async (req, res, [tid, fid]) => {
    member(req, tid);
    const file = store.file.get(fid);
    if (!file || file.tunnel_id !== tid) throw new HttpError(404, 'File not found. Files are kept for 7 days.');
    const data = await readFile(join(app.filesDir, file.id));
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  });

  // ---------- cleanup ----------

  app.sweeps.push(async () => {
    const now = Date.now();
    const cutoff = now - options.ttlMs;
    store.deleteExpiredInvites.run(now);
    store.deleteOldMessages.run(cutoff);
    const old = store.oldFiles.all(cutoff);
    store.deleteOldFiles.run(cutoff);
    await Promise.all(old.map((f) => unlink(join(app.filesDir, f.id)).catch(() => {})));
  });

  return {
    /** Release every waiting long-poll, so the server can close. */
    wakeAll() {
      for (const id of [...waiters.keys()]) wake(id);
    },
  };
}
