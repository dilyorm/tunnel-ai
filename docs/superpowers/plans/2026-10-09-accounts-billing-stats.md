# Accounts, Billing, Stats and Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tunnel optional accounts (GitHub and email sign-in), flat Plus/Pro plans billed through Lemon Squeezy, per-plan limits, cookieless stats, an admin page, and the matching landing, account and legal pages, all while a relay with no settings behaves exactly as it does today.

**Architecture:** The relay stays one zero-dependency Node process with one SQLite file. `relay/server.ts` becomes a thin HTTP shell that builds an `App` object (store, routing, limiters, feature settings, plans, stats) and hands it to feature modules: `tunnels.ts` (today's routes), `plans.ts`, `stats.ts`, `accounts.ts`, `auth-email.ts`, `auth-github.ts`, `billing/`, `admin.ts`. Each module registers its own routes and sweep work, and only switches on when its environment variables are set. The site becomes a Vite multi-page build with account, admin and legal pages that call the relay's `/v1/*` API on the same origin.

**Tech Stack:** TypeScript (TS 7, NodeNext, `verbatimModuleSyntax`), Node ≥ 22.13 (`node:sqlite`, `node:http`, `node:crypto`, global `fetch`), `node:test` with tsx, Vite 8 (vanilla TS) for the site, nginx and systemd on the server.

**Spec:** `docs/superpowers/specs/2026-10-09-accounts-billing-stats-design.md`

## Global Constraints

- Zero runtime dependencies in `cli/`. Only `node:*` modules and the global `fetch`.
- Node ≥ 22.13 (`engines` in `cli/package.json`). The local machine runs v22.21.0 on Windows; every command below must work in Git Bash there.
- With no feature variables set, the relay behaves as today: the 19 tests in `cli/test/tunnel.test.ts` pass **unchanged**, and every new route returns 404.
- Feature switches: `TUNNEL_PUBLIC_URL` turns on accounts; `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` GitHub sign-in; `RESEND_API_KEY` + `TUNNEL_EMAIL_FROM` email sign-in; `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_VARIANT_PLUS`, `LEMONSQUEEZY_VARIANT_PRO` billing; `TUNNEL_ADMIN_EMAILS` admin and stats; `TUNNEL_STATS_SALT` unique-visitor hashing. Half a group logs a warning naming the missing variable and leaves that feature off.
- Every outbound HTTP call (GitHub, Resend, Lemon Squeezy) goes through `app.fetch`, which tests replace with a stub.
- Secrets (session tokens, magic-link tokens, poll tokens, OAuth states) are stored only as sha256 hex. Never log tokens, secrets or webhook bodies.
- Cookies: `tunnel_session` is `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`, plus `Secure` unless `TUNNEL_PUBLIC_URL` starts with `http://`. `tunnel_signed_in=1` has the same flags minus `HttpOnly`.
- Browser POSTs to `/v1/auth/*`, `/v1/account/*` and `/v1/admin/*` need `Origin` equal to `TUNNEL_PUBLIC_URL`, else 403. CLI routes (`/v1/auth/device*`, `/v1/devices/me*`), the webhook and `/v1/hit` don't.
- `return_to` is a same-site path: starts with `/`, not `//`, no backslash, no control characters, at most 512 characters; anything else becomes `/account`.
- Plans (the only source is `relay/plans.ts`): Free 1 tunnel per device (the cap is `TUNNEL_MAX_TUNNELS`, 0 = unlimited), 10 MB files, 7 days, no storage cap; Plus $5: 10 tunnels per account, 50 MB, 30 days, 2 GB; Pro $9: 20 tunnels per account, 100 MB, 30 days, 5 GB.
- Over the tunnel cap → 403. Over the file size or storage → 413. Both name the plan and the next step.
- Admin routes return 404 to anyone who isn't an admin, signed in or not.
- Stats are cookieless: no raw IP is stored; visitor hashes are deleted when their day ends.
- User-facing text is plain: say what happened and what to do next. No apologies, no jargon.
- Tests: `cd cli && npm test` (all), `cd cli && npm run typecheck`, `cd site && npm run build && npm run check` (the check exists from Task 10).
- Commit after every task. Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Nothing is pushed or deployed until the user says so (Task 13 asks first).

## Review Focus

1. **A mail scanner opens the magic link before the person does** (Outlook, Gmail and corporate gateways prefetch links). The link must still sign the person in. Test: `a mail scanner opening the link does not use it up` in Task 5.
2. **`return_to` set to `/\evil.com`, `//evil.com` or `/<tab>evil`** must not redirect off-site after sign-in. Test: `return_to only accepts paths on this site` in Task 5.
3. **Slow streamed uploads, and chunked uploads past the limit.** A slow upload must not be cut off by a request timeout, and an over-limit upload must get a 413 (not a reset connection) and leave no partial file on disk. Tests: `a slow chunked upload is saved whole and downloads the same` and `an over-limit chunked upload gets 413 and leaves no file behind` in Task 3.
4. **A Plus customer clicks "Get Pro"** (or reruns `tunnel upgrade pro`). Starting a second subscription would double-bill them; they must be told to switch plans from Manage billing. Test: `a Plus or Pro customer cannot open a second subscription` in Task 8.
5. **Webhooks arrive out of order** (Lemon Squeezy retries). An old `expired` event delivered after a newer `active` one must not downgrade a paying customer. Test: `an older event arriving late does not undo a newer one` in Task 8.

## Where this plan deliberately differs from the spec

1. **Magic link:** `GET /v1/auth/email/verify?token=…` only redirects to `/account?login=TOKEN`. The account page spends the token with `POST /v1/auth/email/verify {token}` → 200 `{returnTo}` plus cookies, or 410. Mail scanners can't use the link up (Review Focus 1).
2. **`subscriptions.active INTEGER NOT NULL`** is stored next to the verbatim status, and every query treats a subscription as live when `active = 1 AND (ends_at IS NULL OR ends_at > now)`.
3. **`BillingEvent`** gains `type` and `updatedAt`, drops `id` (the route hashes the raw body itself) and `portalUrl`. **`BillingProvider`** gains `portalUrl(subscriptionId)`, because Lemon Squeezy portal links expire after 24 hours and must be fetched fresh. So `subscriptions` has no `portal_url` column, and `parse` returns `undefined` (not `null`) for events we ignore.
4. **`tunnel_signed_in=1`** hint cookie (not secret) so static pages can show "Account" without an API call.
5. **New endpoints:** `GET /v1/devices/me` (for `tunnel account`) and `POST /v1/account/devices/:id/unlink` (the account page's Unlink button).
6. **`LIMITS` moves to `relay/http.ts`** and is re-exported from `server.ts`. Feature settings live in a new `relay/config.ts`. Statements for new tables live in the module that owns them, created through `store.prepare`.
7. **Uploads and downloads stream** to and from disk instead of being buffered, `server.requestTimeout = 0` and `server.timeout = 120_000` (idle). A 100 MB buffered upload would press against `MemoryMax=512M`, and the old 85 s request timeout would cut slow uploads.
8. **Stats are on only when admin is on** (`TUNNEL_ADMIN_EMAILS` set, which needs `TUNNEL_PUBLIC_URL`). Self-hosters get no beacon route and no counters.
9. **`RelayOptions.linkPollSeconds`** (default 3) so tests poll fast.
10. **`active_members(day, member_id)`** table. Device tokens are only used by `open`, `login`, `account` and `upgrade`, so "active devices" alone would read near zero; tunnel members are what agents use every turn. The admin page shows active agents, machines and accounts.
11. **`billing_events` rows are swept after 90 days.** Subscriptions are kept.
12. **GitHub OAuth binds the state to the browser** with a 10-minute `tunnel_oauth` cookie, so a stranger can't finish a sign-in someone else started (login CSRF).
13. **Plan limit messages say "per device"**, as today's message does, so the original quota test passes unchanged; the site says "per machine".
14. **A machine is linked the moment the person confirms the code** in the browser, so the account page lists it straight away. The CLI's poll only reports the result and removes the pending link.
15. **`POST /v1/account/devices/link` is rate-limited** to 20 tries per account per 10 minutes, so a signed-in stranger can't guess other people's codes.
16. **The upload limit messages name the tunnel's owner**, because the owner's plan decides the limit for every member.
17. **The CLI prints plan names capitalized** ("Linked to ada@example.com (Free).", "Plan: Plus"), matching the site, where the spec's examples show "(free)".
18. **nginx passes `$request_uri` to the install counter, not `$uri`.** Inside the mirror subrequest `$uri` is `/_count`; `$request_uri` is the original download path.
19. **`build.rolldownOptions.input`**, not `rollupOptions`: Vite 8 bundles with Rolldown.
20. **The charts are written out in Task 12** (inline SVG, no library) instead of being designed at implementation time.
21. **Active accounts** also count accounts that used the site in the window, not only those with an active linked machine.
22. **Two additions for building the site:** `site/scripts/check.mjs` (`npm run check`) inspects the built pages and is the site tasks' failing test; `cli/scripts/dev-relay.ts` (`npm run dev-relay`) runs a relay with every feature on and email and payments faked, so the account and admin pages can be tried in a browser.
23. **`tunnel login` opens the browser on Windows with `rundll32 url.dll,FileProtocolHandler`**, because `start` is a cmd builtin, not a program.
24. **`tunnel account` on a machine that isn't linked** prints "Not signed in (Free plan). Run `tunnel login` to link this machine to an account." and then the Free limits, so the person sees what they have now.
25. **Upgrade buttons and checkout are offered only while no subscription is live.** A Plus customer moves to Pro through Manage billing (Review Focus 4).
26. **"Manage billing" shows only while a subscription is live.** After a cancelled plan has ended there is nothing left to manage, and Lemon Squeezy emails every receipt and invoice.

## File map

**Relay (`cli/src/relay/`)**

| File | Status | Job |
|---|---|---|
| `http.ts` | new | `LIMITS`, `HttpError`, `Handler`, body/JSON readers, `send`, cookies, redirects, `safeReturn` |
| `config.ts` | new | `readFeatures(env)`: which features are on |
| `server.ts` | rewrite | HTTP shell: `App`, routing, limiters, device auth, sweep loop, module wiring |
| `tunnels.ts` | new (moved) | Devices, tunnels, invites, members, messages, files; plan checks; streaming files |
| `plans.ts` | new | `PLANS`, `PRICES`, plan lookups and limit checks |
| `stats.ts` | new | Daily counters, active devices/agents, `/v1/hit`, `/internal/install` |
| `accounts.ts` | new | Accounts, sessions, `/v1/account*`, `/v1/auth/methods`, logout, machine linking |
| `auth-email.ts` | new | Magic-link sign-in through Resend |
| `auth-github.ts` | new | GitHub OAuth |
| `billing/index.ts` | new | Provider interface, checkout, portal, webhook, plan recompute |
| `billing/lemonsqueezy.ts` | new | Lemon Squeezy adapter |
| `admin.ts` | new | Admin stats and accounts API |
| `db.ts` | modify | New tables, column migrations, `prepare`, expiry statements |

**CLI (`cli/src/`)**: `commands.ts` (export helpers, `withDevice`, drop the 10 MB check), `account-commands.ts` (new: login, logout, account, upgrade), `cli.ts` (help and commands), `bin.ts` (`openUrl`), `skills/tunnel/SKILL.md` (plan-limit rule), `scripts/dev-relay.ts` (new), `package.json` (`dev-relay` script), `tsconfig.json` (include `scripts`).

**Tests (`cli/test/`)**: `helpers.ts`, `setup.test.ts`, `plans.test.ts`, `stats.test.ts`, `accounts.test.ts`, `github.test.ts`, `link.test.ts`, `billing.test.ts`, `admin.test.ts`. `tunnel.test.ts` is not touched.

**Site (`site/`)**: `package.json` (`check` script), `scripts/check.mjs` (new: checks the built `dist/`), `vite.config.ts`, `index.html`, `account.html`, `admin.html`, `terms.html`, `privacy.html`, `refund.html`, `src/page.ts`, `src/legal.ts`, `src/account.ts`, `src/admin.ts`, `src/chart.ts`, `src/app.css`, `src/style.css`, `src/main.ts`, `public/robots.txt`, `public/llms.txt`.

**Deploy**: `deploy/tunnel-relay.service`, `deploy/tunnel-relay.env.example` (new), `deploy/nginx.conf`, `README.md`, `.gitignore`, `.claude/launch.json`.

## Final shape of the shared interfaces

Later tasks rely on these names. Each is introduced by the task named in brackets.

```ts
// relay/server.ts
export interface App {
  store: Store;                                   // [1]
  filesDir: string;                               // [1]
  on(method: string, pattern: string, handler: Handler): void;          // [1]
  clientOf(req: IncomingMessage): string;                               // [1]
  counter(windowMs: number, max: number, message: string): (req: IncomingMessage, key?: string) => void; // [1]
  device(req: IncomingMessage): Device;           // [1] returns {id}; [2] returns Device
  sweeps: (() => void | Promise<void>)[];         // [1]
  features: Features;                             // [2]
  fetch: typeof fetch;                            // [2]
  log(line: string): void;                        // [2]
  linkPollSeconds: number;                        // [2]
  plans: Plans;                                   // [3]
  stats: Stats;                                   // [4]
  billing?: Billing;                              // [8]
}
export interface Relay { url: string; sweep(): Promise<void>; close(): Promise<void> } // sweep from [3]
```

---

### Task 1: Split `server.ts` into an HTTP shell and a tunnels module (no behaviour change)

**Files:**
- Create: `cli/src/relay/http.ts`
- Create: `cli/src/relay/tunnels.ts`
- Modify (rewrite): `cli/src/relay/server.ts`
- Test: `cli/test/tunnel.test.ts` (unchanged; it is the safety net)

**Interfaces:**
- Consumes: `openStore`, `Store`, `Member` from `./db.js` (unchanged); `secretToken`, `sha256`, `shortId` from `../crypto.js`.
- Produces:
  - `http.ts`: `LIMITS`, `class HttpError(status: number, message: string)`, `type Handler = (req, res, params: string[], url: URL) => Promise<void>`, `body(req, max): Promise<Buffer>`, `json<T>(req, max = LIMITS.jsonBody): Promise<T>`, `str(value, name, max): string`, `bearer(req): string`, `send(res, status, payload?, headers?)`.
  - `tunnels.ts`: `tunnelRoutes(app: App, options: { ttlMs: number }): { wakeAll(): void }`.
  - `server.ts`: `App` (fields marked [1] above), `startRelay`, `RelayOptions`, `Relay`, and `export { LIMITS } from './http.js'`.

This task is a pure move, with one deliberate change: `json()` answers 400 "Body must be a JSON object." for a body that is valid JSON but not an object (today `null` or `5` reaches a handler and becomes a 500). The existing suite already covers every route, so "the failing test" step is replaced by running it before and after.

- [ ] **Step 1: Run the existing suite to record the baseline**

Run: `cd cli && npm test`
Expected: `# pass 19`, `# fail 0`.

- [ ] **Step 2: Create `cli/src/relay/http.ts`**

```ts
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

// Helpers shared by every route module. An HttpError reaches the client as {"error": message};
// anything else thrown in a handler is a relay bug and becomes a 500.

export const LIMITS = {
  messageBytes: 96 * 1024, // sealed + base64 form of a 64 KB message
  profileBytes: 2 * 1024,
  fileBytes: 10 * 1024 * 1024 + 64,
  jsonBody: 256 * 1024,
  inviteTtlMs: 15 * 60 * 1000,
  inviteAttempts: 3,
  maxWaitS: 55,
  requestsPerMinute: 600,
  devicesPerHour: 10,
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>;

export async function body(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `Body too large (limit ${max} bytes).`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function json<T>(req: IncomingMessage, max = LIMITS.jsonBody): Promise<T> {
  const raw = await body(req, max);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Body is not valid JSON.');
  }
  // `null` or `5` would make handlers throw a TypeError (a 500); refuse them here instead.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Body must be a JSON object.');
  }
  return value as T;
}

export function str(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0) throw new HttpError(400, `Missing ${name}.`);
  if (value.length > max) throw new HttpError(413, `${name} is too large.`);
  return value;
}

export function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new HttpError(401, 'Missing token.');
  return match[1];
}

export function send(res: ServerResponse, status: number, payload?: unknown, headers: OutgoingHttpHeaders = {}) {
  if (payload === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}
```

- [ ] **Step 3: Create `cli/src/relay/tunnels.ts`** (the routes from `server.ts`, moved as they are)

```ts
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
```

- [ ] **Step 4: Rewrite `cli/src/relay/server.ts` as the shell**

```ts
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { sha256 } from '../crypto.js';
import { VERSION } from '../version.js';
import { openStore, type Store } from './db.js';
import { HttpError, LIMITS, bearer, send, type Handler } from './http.js';
import { tunnelRoutes } from './tunnels.js';

export { LIMITS } from './http.js';

// The relay is a mailbox for ciphertext. This file is only the HTTP shell: routing, rate limits,
// device auth and the sweep loop. Feature modules register their routes on the App.

export interface RelayOptions {
  port?: number;
  host?: string;
  dataDir: string;
  /** Tunnels one device may own at once. 0 means unlimited. */
  maxTunnelsPerDevice?: number;
  /** How long messages and files are kept. */
  ttlMs?: number;
  /** Honour X-Forwarded-For when behind a reverse proxy. */
  trustProxy?: boolean;
}

export interface Relay {
  url: string;
  close(): Promise<void>;
}

/** What a feature module gets: the store, routing, limiters and device auth. */
export interface App {
  store: Store;
  filesDir: string;
  maxTunnelsPerDevice: number;
  on(method: string, pattern: string, handler: Handler): void;
  clientOf(req: IncomingMessage): string;
  /** A fixed-window limiter. It counts per client address unless the caller passes a key. */
  counter(windowMs: number, max: number, message: string): (req: IncomingMessage, key?: string) => void;
  /** The device behind the request's bearer token, or a 401. */
  device(req: IncomingMessage): { id: string };
  /** Work for the 10-minute sweep (expiry, cleanup). */
  sweeps: (() => void | Promise<void>)[];
}

const DAY = 24 * 60 * 60 * 1000;

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const store = await openStore(options.dataDir);
  const routes: [string, RegExp, Handler][] = [];

  function clientOf(req: IncomingMessage): string {
    // Behind a proxy, the proxy must overwrite X-Forwarded-For; the first entry is trusted.
    const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '') : '';
    return forwarded.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  }

  function counter(windowMs: number, max: number, message: string) {
    let start = Date.now();
    const hits = new Map<string, number>();
    return (req: IncomingMessage, key = clientOf(req)) => {
      const now = Date.now();
      if (now - start > windowMs) {
        start = now;
        hits.clear();
      }
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      if (n > max) throw new HttpError(429, message);
    };
  }

  const app: App = {
    store,
    filesDir: join(options.dataDir, 'files'),
    maxTunnelsPerDevice: options.maxTunnelsPerDevice ?? 0,
    on(method, pattern, handler) {
      routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), handler]);
    },
    clientOf,
    counter,
    device(req) {
      const row = store.deviceByToken.get(sha256(bearer(req)));
      if (!row) throw new HttpError(401, 'Unknown device.');
      return row;
    },
    sweeps: [],
  };

  const limit = counter(60_000, LIMITS.requestsPerMinute, 'Too many requests. Slow down and retry in a minute.');

  app.on('GET', '/v1/health', async (_req, res) => send(res, 200, { ok: true, version: VERSION }));
  const tunnels = tunnelRoutes(app, { ttlMs: options.ttlMs ?? 7 * DAY });

  const server = createServer(async (req, res) => {
    try {
      limit(req);
      const url = new URL(req.url ?? '/', 'http://relay');
      for (const [method, re, handler] of routes) {
        const match = re.exec(url.pathname);
        if (match && method === req.method) {
          await handler(req, res, match.slice(1).map(decodeURIComponent), url);
          return;
        }
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message });
      } else {
        console.error('[relay]', error);
        send(res, 500, { error: 'Relay error.' });
      }
    }
  });
  // long-polls hold requests open; keep sockets alive a little longer than the longest wait
  server.requestTimeout = (LIMITS.maxWaitS + 30) * 1000;
  server.keepAliveTimeout = 65_000;

  async function sweep() {
    for (const fn of app.sweeps) {
      try {
        await fn();
      } catch (error) {
        console.error('[relay] sweep failed', error);
      }
    }
  }
  const timer = setInterval(() => void sweep(), 10 * 60 * 1000);
  timer.unref();
  await sweep();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, options.host ?? '0.0.0.0', resolve);
  });
  const address = server.address() as AddressInfo;
  const host = !options.host || options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;

  return {
    url: `http://${host}:${address.port}`,
    async close() {
      clearInterval(timer);
      tunnels.wakeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
```

- [ ] **Step 5: Run the suite and the type check**

Run: `cd cli && npm test && npm run typecheck`
Expected: `# pass 19`, `# fail 0`, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add cli/src/relay/http.ts cli/src/relay/tunnels.ts cli/src/relay/server.ts
git commit -m "refactor(relay): split the HTTP shell from the tunnel routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema migrations, feature settings and test helpers

**Files:**
- Modify: `cli/src/relay/db.ts`
- Create: `cli/src/relay/config.ts`
- Modify: `cli/src/relay/server.ts`
- Modify: `cli/src/commands.ts` (`relayCmd` only)
- Create: `cli/test/helpers.ts`
- Test: `cli/test/setup.test.ts`

**Interfaces:**
- Consumes: Task 1's `App`, `startRelay`.
- Produces:
  - `db.ts`: `interface Device { id: string; account_id: string | null; seen: number | null }`, `interface Account { id; email; github_id: number | null; github_login: string | null; plan: 'free' | 'plus' | 'pro'; plan_source: string | null; plan_until: number | null; created: number; seen: number }`, `store.prepare<T>(sql)` with `.get/.all/.run`, `store.deviceByToken` returning `Device`, `store.touchDevice`.
  - `config.ts`: `type Env = Record<string, string | undefined>`, `interface Features`, `readFeatures(env, warn?): Features`.
  - `server.ts`: `RelayOptions.env`, `.fetch`, `.log`, `.linkPollSeconds`; `App.features`, `.fetch`, `.log`, `.linkPollSeconds`; `App.device()` returns `Device` and records `devices.seen` at most hourly.
  - `test/helpers.ts`: `tmp`, `sleep`, `DAY`, `PUBLIC_URL = 'http://tunnel.test'`, `ADMIN = 'boss@example.com'`, `FULL_ENV`, `relay(options?) → TestRelay` (adds `dataDir`), `agent(relayOf, label) → { home, cwd, run(...argv), deviceId(), tunnel(name) }`, `type Agent`, `sql(dataDir, statement, ...params): Promise<any[]>`.

- [ ] **Step 1: Write the test helpers, `cli/test/helpers.ts`**

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { openStore } from '../src/relay/db.js';
import { startRelay, type Relay, type RelayOptions } from '../src/relay/server.js';
import type { TunnelRecord } from '../src/store.js';

// Shared by the account, billing, stats and admin suites. tunnel.test.ts keeps its own copies so the
// original suite runs unchanged.

export const tmp = (label: string) => mkdtempSync(join(tmpdir(), `tunnel-${label}-`));
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const DAY = 24 * 60 * 60 * 1000;
export const PUBLIC_URL = 'http://tunnel.test';
export const ADMIN = 'boss@example.com';

/** Every feature switched on against fake services. Pair it with `fetch: outbound().fetch`. */
export const FULL_ENV: Record<string, string> = {
  TUNNEL_PUBLIC_URL: PUBLIC_URL,
  GITHUB_CLIENT_ID: 'gh-id',
  GITHUB_CLIENT_SECRET: 'gh-secret',
  RESEND_API_KEY: 're_test',
  TUNNEL_EMAIL_FROM: 'tunnel <login@tunnel.test>',
  LEMONSQUEEZY_API_KEY: 'ls_test',
  LEMONSQUEEZY_STORE_ID: '11',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'whsec',
  LEMONSQUEEZY_VARIANT_PLUS: '101',
  LEMONSQUEEZY_VARIANT_PRO: '102',
  TUNNEL_ADMIN_EMAILS: ADMIN,
  TUNNEL_STATS_SALT: 'salt',
};

export interface TestRelay extends Relay {
  dataDir: string;
}

export async function relay(options: Partial<RelayOptions> = {}): Promise<TestRelay> {
  const dataDir = options.dataDir ?? tmp('relay');
  const started = await startRelay({ port: 0, host: '127.0.0.1', log: () => {}, ...options, dataDir });
  return Object.assign(started, { dataDir });
}

export type Agent = ReturnType<typeof agent>;

/** One machine running the CLI against a relay, with its own ~/.tunnel. */
export function agent(relayOf: () => { url: string }, label: string) {
  const home = tmp(label);
  const cwd = tmp(`${label}-cwd`);
  const read = <T>(file: string) => JSON.parse(readFileSync(join(home, file), 'utf8')) as T;
  return {
    home,
    cwd,
    async run(...argv: string[]) {
      let out = '';
      let err = '';
      const code = await run(argv, {
        env: { TUNNEL_HOME: home, TUNNEL_RELAY: relayOf().url },
        cwd,
        out: (s) => (out += s + '\n'),
        err: (s) => (err += s + '\n'),
      });
      return { code, out, err };
    },
    deviceId: () => read<{ devices: Record<string, { id: string }> }>('config.json').devices[relayOf().url].id,
    tunnel: (name: string) => read<Record<string, TunnelRecord>>('tunnels.json')[name],
  };
}

/** One statement against a relay's database, through a second connection. Rows come back as plain objects. */
export async function sql(dataDir: string, statement: string, ...params: (string | number | null)[]): Promise<any[]> {
  const store = await openStore(dataDir);
  try {
    return store.db.prepare(statement).all(...params).map((row) => ({ ...row }));
  } finally {
    store.close();
  }
}
```

- [ ] **Step 2: Write the failing test, `cli/test/setup.test.ts`**

```ts
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/setup.test.ts`
Expected: FAIL, `Cannot find module '../src/relay/config.js'`.

- [ ] **Step 4: Create `cli/src/relay/config.ts`**

```ts
// Which optional features this relay runs. Every feature is off until all of its variables are set,
// so a self-hosted relay with no settings behaves exactly like the plain mailbox.

export type Env = Record<string, string | undefined>;

export interface Features {
  /** Origin of the site and relay, e.g. https://tunnel.dilyor.dev. Accounts need it. */
  publicUrl?: string;
  github?: { clientId: string; clientSecret: string };
  email?: { apiKey: string; from: string };
  billing?: {
    apiKey: string;
    storeId: string;
    webhookSecret: string;
    variants: { plus: string; pro: string };
  };
  /** Lowercased. Non-empty also turns on stats. */
  adminEmails: Set<string>;
  statsSalt?: string;
}

const GROUPS = {
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  email: ['RESEND_API_KEY', 'TUNNEL_EMAIL_FROM'],
  billing: [
    'LEMONSQUEEZY_API_KEY',
    'LEMONSQUEEZY_STORE_ID',
    'LEMONSQUEEZY_WEBHOOK_SECRET',
    'LEMONSQUEEZY_VARIANT_PLUS',
    'LEMONSQUEEZY_VARIANT_PRO',
  ],
} as const;

const LABELS: Record<keyof typeof GROUPS, string> = {
  github: 'GitHub sign-in',
  email: 'Email sign-in',
  billing: 'Billing',
};

export function readFeatures(env: Env, warn: (line: string) => void = () => {}): Features {
  const value = (name: string) => env[name]?.trim() || undefined;

  let publicUrl = value('TUNNEL_PUBLIC_URL')?.replace(/\/+$/, '');
  if (publicUrl && !/^https?:\/\/[^/\s]+$/.test(publicUrl)) {
    warn(`TUNNEL_PUBLIC_URL must look like https://tunnel.example.com, got "${publicUrl}". Accounts are off.`);
    publicUrl = undefined;
  }

  const group = (key: keyof typeof GROUPS): string[] | undefined => {
    const names: readonly string[] = GROUPS[key];
    const values = names.map(value);
    if (values.every((v) => v === undefined)) return undefined;
    const missing = names.filter((_, i) => values[i] === undefined);
    if (missing.length) {
      warn(`${LABELS[key]} is off: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`);
      return undefined;
    }
    if (!publicUrl) {
      warn(`${LABELS[key]} is off: TUNNEL_PUBLIC_URL is not set.`);
      return undefined;
    }
    return values as string[];
  };

  const github = group('github');
  const email = group('email');
  const billing = group('billing');

  const admins = (value('TUNNEL_ADMIN_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (admins.length && !publicUrl) warn('Admin is off: TUNNEL_PUBLIC_URL is not set.');

  return {
    publicUrl,
    github: github && { clientId: github[0], clientSecret: github[1] },
    email: email && { apiKey: email[0], from: email[1] },
    billing: billing && {
      apiKey: billing[0],
      storeId: billing[1],
      webhookSecret: billing[2],
      variants: { plus: billing[3], pro: billing[4] },
    },
    adminEmails: new Set(publicUrl ? admins : []),
    statsSalt: value('TUNNEL_STATS_SALT'),
  };
}
```

- [ ] **Step 5: Extend `cli/src/relay/db.ts`**

Replace the `SCHEMA` constant with the version below (the first six tables are unchanged; `busy_timeout` and everything after the `files` table is new), add `COLUMNS` and `AFTER_COLUMNS` under it, and add the `Device` and `Account` interfaces next to the existing ones.

```ts
const DAY = 24 * 60 * 60 * 1000;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  owner_device TEXT NOT NULL,
  owner_member TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  profile TEXT,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  ct TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (tunnel_id, seq)
);

CREATE TABLE IF NOT EXISTS invites (
  slot INTEGER PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  salt TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  tunnel_id TEXT NOT NULL REFERENCES tunnels(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_created ON messages(created);
CREATE INDEX IF NOT EXISTS files_created ON files(created);
CREATE INDEX IF NOT EXISTS tunnels_owner ON tunnels(owner_device);

-- accounts and sign-in
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  github_id INTEGER UNIQUE,
  github_login TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_source TEXT,
  plan_until INTEGER,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS email_logins (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_links (
  user_code TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);

-- billing
CREATE TABLE IF NOT EXISTS subscriptions (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  active INTEGER NOT NULL,
  renews_at INTEGER,
  ends_at INTEGER,
  updated INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_account ON subscriptions(account_id);
CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, received INTEGER NOT NULL);

-- stats (UTC days, 'YYYY-MM-DD')
CREATE TABLE IF NOT EXISTS stats_daily (
  day TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric)
);
CREATE TABLE IF NOT EXISTS active_devices (day TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (day, device_id));
CREATE TABLE IF NOT EXISTS active_members (day TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (day, member_id));
CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash));
CREATE TABLE IF NOT EXISTS referrers (
  day TEXT NOT NULL, host TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, host)
);
`;

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so each is checked first.
const COLUMNS: [table: string, column: string, type: string][] = [
  ['devices', 'account_id', 'TEXT REFERENCES accounts(id) ON DELETE SET NULL'],
  ['devices', 'seen', 'INTEGER'],
  ['messages', 'expires', 'INTEGER'],
  ['files', 'expires', 'INTEGER'],
];

// Rows from before plan-aware expiry keep the old fixed 7 days.
const AFTER_COLUMNS = `
UPDATE messages SET expires = created + ${7 * DAY} WHERE expires IS NULL;
UPDATE files SET expires = created + ${7 * DAY} WHERE expires IS NULL;
CREATE INDEX IF NOT EXISTS messages_expires ON messages(expires);
CREATE INDEX IF NOT EXISTS files_expires ON files(expires);
CREATE INDEX IF NOT EXISTS devices_account ON devices(account_id);
`;
```

```ts
export interface Device {
  id: string;
  account_id: string | null;
  seen: number | null;
}

export interface Account {
  id: string;
  email: string;
  github_id: number | null;
  github_login: string | null;
  plan: 'free' | 'plus' | 'pro';
  plan_source: string | null;
  plan_until: number | null;
  created: number;
  seen: number;
}
```

In `openStore`, run the migrations right after `db.exec(SCHEMA);`:

```ts
  db.exec(SCHEMA);
  for (const [table, column, type] of COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec(AFTER_COLUMNS);
```

In the statements object `s`, replace `deviceByToken` and add `touchDevice`:

```ts
    deviceByToken: q<Device>('SELECT id, account_id, seen FROM devices WHERE token_hash = ?'),
    insertDevice: q('INSERT INTO devices (id, token_hash, created) VALUES (?, ?, ?)'),
    touchDevice: q('UPDATE devices SET seen = ? WHERE id = ?'),
```

And expose `q` so feature modules can prepare their own statements. Replace the last line of `openStore`:

```ts
  return { db, prepare: q, ...s, close: () => db.close() };
```

- [ ] **Step 6: Wire settings into `cli/src/relay/server.ts`**

Add imports:

```ts
import { openStore, type Device, type Store } from './db.js';
import { readFeatures, type Env, type Features } from './config.js';
```

(Replace the existing `import { openStore, type Store } from './db.js';` line with the first one.)

Add to `RelayOptions`:

```ts
  /** Feature settings (TUNNEL_PUBLIC_URL, GITHUB_*, …). Nothing set means a plain relay. */
  env?: Env;
  /** Outbound HTTP to GitHub, Resend and Lemon Squeezy. Tests pass a stub. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** How often `tunnel login` polls for approval, in seconds. */
  linkPollSeconds?: number;
```

In `App`, change `device` and add four fields:

```ts
  /** The device behind the request's bearer token, or a 401. */
  device(req: IncomingMessage): Device;
  features: Features;
  fetch: typeof fetch;
  log(line: string): void;
  linkPollSeconds: number;
```

Above `const DAY`, add `const HOUR = 60 * 60 * 1000;`. In `startRelay`, after `const routes = …`, add:

```ts
  const log = options.log ?? ((line: string) => console.log(`[relay] ${line}`));
  const features = readFeatures(options.env ?? {}, log);
```

In the `app` literal, add the four fields and replace `device`:

```ts
    features,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    log,
    linkPollSeconds: options.linkPollSeconds ?? 3,
    device(req) {
      const row = store.deviceByToken.get(sha256(bearer(req)));
      if (!row) throw new HttpError(401, 'Unknown device.');
      const now = Date.now();
      if (row.seen === null || now - row.seen > HOUR) store.touchDevice.run(now, row.id);
      return row;
    },
```

- [ ] **Step 7: Pass the environment from `relayCmd` in `cli/src/commands.ts`**

In `relayCmd`, add two options to the `startRelay({ … })` call, next to the `trustProxy` line that is already there:

```ts
    env: ctx.env,
    log: (line) => ctx.err(line),
```

- [ ] **Step 8: Run the new test and the whole suite**

Run: `cd cli && node --import tsx --test test/setup.test.ts && npm test && npm run typecheck`
Expected: setup tests PASS (9 tests); full suite `# fail 0`; no type errors.

- [ ] **Step 9: Commit**

```bash
git add cli/src/relay/db.ts cli/src/relay/config.ts cli/src/relay/server.ts cli/src/commands.ts cli/test/helpers.ts cli/test/setup.test.ts
git commit -m "feat(relay): schema for accounts, billing and stats, and feature settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Plans and per-plan limits, with streamed files

**Files:**
- Create: `cli/src/relay/plans.ts`
- Modify: `cli/src/relay/db.ts` (message and file statements)
- Modify: `cli/src/relay/http.ts` (drop `LIMITS.fileBytes`)
- Modify: `cli/src/relay/tunnels.ts` (tunnel cap, expiry, streamed upload and download, sweep)
- Modify: `cli/src/relay/server.ts` (`App.plans`, `Relay.sweep`, timeouts, drain unread bodies)
- Modify: `cli/src/commands.ts` (drop the client-side 10 MB check)
- Modify: `cli/src/cli.ts` (help text)
- Modify: `cli/test/helpers.ts` (add `grant`)
- Test: `cli/test/plans.test.ts`

**Interfaces:**
- Consumes: `App`, `Store.prepare`, `Device` (Task 2); `store.countTunnels` (existing).
- Produces:
  - `plans.ts`: `MB`, `GB`, `type PlanName = 'free' | 'plus' | 'pro'`, `interface Limits { tunnels: number; perDevice: boolean; fileBytes: number; historyDays: number; storageBytes: number }`, `PLANS`, `PRICES = { plus: 5, pro: 9 }`, `RANK`, `SEAL_OVERHEAD = 64`, `planNamed(value): PlanName | undefined`, `title(plan): string` ("Free", "Plus", "Pro"), `formatBytes(n): string` ("10 MB", "2 GB"), `interface Plans`, `createPlans(store, { freeCap, upgradeHint }): Plans`.
  - `Plans`: `ofAccount(accountId: string | null): PlanName`, `ofTunnel(tunnelId): PlanName`, `limitsOf(plan): Limits` (Free's `tunnels` is the relay's `TUNNEL_MAX_TUNNELS`), `tunnelsOf(device: Device): { plan; used; limit }`, `accountTunnels(accountId): number`, `storedBytes(accountId): number`, `expires(tunnelId, now?): number`, `maxUpload(tunnelId): number`, `checkTunnelCap(device): void` (403), `checkUpload(tunnelId, size): void` (413), `tooBig(tunnelId, size?): HttpError` (413).
  - `App.plans: Plans`; `Relay.sweep(): Promise<void>`; `App.maxTunnelsPerDevice` and `RelayOptions.ttlMs` are removed.
  - `db.ts`: `insertMessage(tunnel_id, seq, member_id, ct, created, expires)`, `insertFile(id, tunnel_id, member_id, size, created, expires)`, `file` returns `{ id, tunnel_id, size }`, new `expiredFiles`, `deleteExpiredFiles`, `deleteExpiredMessages` (each takes `now`).
  - `test/helpers.ts`: `grant(dataDir, plan, ...deviceIds): Promise<string>` returns the new account id.

- [ ] **Step 1: Add `grant` to `cli/test/helpers.ts`**

Add `import { randomUUID } from 'node:crypto';` to the imports, and append:

```ts
/** Put these devices on one new account with `plan`, as an admin grant (billing leaves it alone). Returns the account id. */
export async function grant(dataDir: string, plan: 'free' | 'plus' | 'pro', ...deviceIds: string[]): Promise<string> {
  const store = await openStore(dataDir);
  try {
    const id = `a_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    store.db
      .prepare("INSERT INTO accounts (id, email, plan, plan_source, created, seen) VALUES (?, ?, ?, 'admin', ?, ?)")
      .run(id, `${id}@example.com`, plan, now, now);
    for (const device of deviceIds) store.db.prepare('UPDATE devices SET account_id = ? WHERE id = ?').run(id, device);
    return id;
  } finally {
    store.close();
  }
}
```

- [ ] **Step 2: Write the failing test, `cli/test/plans.test.ts`**

```ts
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/plans.test.ts`
Expected: FAIL, `Cannot find module '../src/relay/plans.js'`.

- [ ] **Step 4: Create `cli/src/relay/plans.ts`**

```ts
import type { Device, Store } from './db.js';
import { HttpError } from './http.js';

// The plans and their limits. This file is the only place these numbers live: the relay enforces
// them and the CLI prints them. The site's pricing cards repeat them by hand.

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
const DAY = 24 * 60 * 60 * 1000;

export type PlanName = 'free' | 'plus' | 'pro';

export interface Limits {
  /** Open tunnels allowed. 0 means no limit. */
  tunnels: number;
  /** true: the cap counts one device's tunnels. false: every device on the account. */
  perDevice: boolean;
  fileBytes: number;
  historyDays: number;
  /** Account-wide file storage. 0 means no cap beyond the file size and the expiry. */
  storageBytes: number;
}

export const PLANS = {
  free: { tunnels: 1, perDevice: true, fileBytes: 10 * MB, historyDays: 7, storageBytes: 0 },
  plus: { tunnels: 10, perDevice: false, fileBytes: 50 * MB, historyDays: 30, storageBytes: 2 * GB },
  pro: { tunnels: 20, perDevice: false, fileBytes: 100 * MB, historyDays: 30, storageBytes: 5 * GB },
} as const satisfies Record<PlanName, Limits>;

/** US dollars a month. */
export const PRICES = { plus: 5, pro: 9 } as const;

export const RANK: Record<PlanName, number> = { free: 0, plus: 1, pro: 2 };

/** Sealing adds a nonce and a tag, so an upload may be this much over the plan's file size. */
export const SEAL_OVERHEAD = 64;

export function planNamed(value: unknown): PlanName | undefined {
  return value === 'free' || value === 'plus' || value === 'pro' ? value : undefined;
}

export const title = (plan: PlanName) => plan[0].toUpperCase() + plan.slice(1);

export function formatBytes(n: number): string {
  if (n >= GB) return `${+(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${+(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export interface Plans {
  /** The plan an account is on now. No account means Free. */
  ofAccount(accountId: string | null): PlanName;
  /** A tunnel follows the plan of the account linked to the device that opened it. */
  ofTunnel(tunnelId: string): PlanName;
  limitsOf(plan: PlanName): Limits;
  /** The tunnel cap as it applies to this device: its own tunnels on Free, the account's on a paid plan. */
  tunnelsOf(device: Device): { plan: PlanName; used: number; limit: number };
  accountTunnels(accountId: string): number;
  storedBytes(accountId: string): number;
  /** When a message or file put in this tunnel now expires. */
  expires(tunnelId: string, now?: number): number;
  /** The most an upload to this tunnel may be, sealed. */
  maxUpload(tunnelId: string): number;
  /** 403 when this device may not open another tunnel. */
  checkTunnelCap(device: Device): void;
  /** 413 when `size` bytes are over the tunnel's file limit or its owner's storage. */
  checkUpload(tunnelId: string, size: number): void;
  /** The 413 for an upload over the file limit. Leave out `size` when the length isn't known yet. */
  tooBig(tunnelId: string, size?: number): HttpError;
}

export function createPlans(store: Store, options: { freeCap: number; upgradeHint: boolean }): Plans {
  const s = {
    accountPlan: store.prepare<{ plan: PlanName }>('SELECT plan FROM accounts WHERE id = ?'),
    tunnelOwner: store.prepare<{ account_id: string | null; plan: PlanName | null }>(
      `SELECT d.account_id, a.plan FROM tunnels t
         LEFT JOIN devices d ON d.id = t.owner_device
         LEFT JOIN accounts a ON a.id = d.account_id
        WHERE t.id = ?`,
    ),
    accountTunnels: store.prepare<{ n: number }>(
      'SELECT COUNT(*) AS n FROM tunnels t JOIN devices d ON d.id = t.owner_device WHERE d.account_id = ?',
    ),
    storedBytes: store.prepare<{ n: number | null }>(
      `SELECT SUM(f.size) AS n FROM files f
         JOIN tunnels t ON t.id = f.tunnel_id
         JOIN devices d ON d.id = t.owner_device
        WHERE d.account_id = ?`,
    ),
  };

  const ofAccount = (accountId: string | null): PlanName => (accountId && s.accountPlan.get(accountId)?.plan) || 'free';

  const owner = (tunnelId: string) => {
    const row = s.tunnelOwner.get(tunnelId);
    return { accountId: row?.account_id ?? null, plan: row?.plan ?? 'free' };
  };

  const limitsOf = (plan: PlanName): Limits =>
    plan === 'free' ? { ...PLANS.free, tunnels: options.freeCap } : PLANS[plan];

  const accountTunnels = (accountId: string) => s.accountTunnels.get(accountId)?.n ?? 0;
  const storedBytes = (accountId: string) => s.storedBytes.get(accountId)?.n ?? 0;

  function tunnelsOf(device: Device) {
    const plan = ofAccount(device.account_id);
    const limits = limitsOf(plan);
    const used =
      limits.perDevice || !device.account_id
        ? (store.countTunnels.get(device.id)?.n ?? 0)
        : accountTunnels(device.account_id);
    return { plan, used, limit: limits.tunnels };
  }

  function tooBig(tunnelId: string, size?: number) {
    const { plan } = owner(tunnelId);
    const limit = formatBytes(limitsOf(plan).fileBytes);
    const what = size === undefined ? `This file is over ${limit}.` : `This file is ${formatBytes(size)}.`;
    let next = '';
    if (options.upgradeHint && plan === 'free') {
      next =
        ` The plan of whoever opened the tunnel applies: Plus takes ${formatBytes(PLANS.plus.fileBytes)}` +
        ` and Pro ${formatBytes(PLANS.pro.fileBytes)} (see \`tunnel upgrade\`).`;
    } else if (options.upgradeHint && plan === 'plus') {
      next = ` Pro takes ${formatBytes(PLANS.pro.fileBytes)}.`;
    }
    return new HttpError(413, `${what} Tunnels on the ${title(plan)} plan take files up to ${limit}.${next}`);
  }

  function checkUpload(tunnelId: string, size: number) {
    const { accountId, plan } = owner(tunnelId);
    const limits = limitsOf(plan);
    if (size > limits.fileBytes + SEAL_OVERHEAD) throw tooBig(tunnelId, size);
    if (!accountId || limits.storageBytes === 0) return;
    const used = storedBytes(accountId);
    if (used + size > limits.storageBytes) {
      throw new HttpError(
        413,
        `This upload would take the tunnel owner's account past its ${formatBytes(limits.storageBytes)} of file ` +
          `storage (${formatBytes(used)} in use). Files are deleted after ${limits.historyDays} days, ` +
          'or when their tunnel is closed.',
      );
    }
  }

  function checkTunnelCap(device: Device) {
    const { plan, used, limit } = tunnelsOf(device);
    if (limit === 0 || used < limit) return;
    if (plan === 'free') {
      throw new HttpError(
        403,
        `The Free plan allows ${limit} open tunnel${limit === 1 ? '' : 's'} per device. Close one with \`tunnel close\`.` +
          (options.upgradeHint ? ` Run \`tunnel upgrade\` for ${PLANS.plus.tunnels} or ${PLANS.pro.tunnels} tunnels.` : ''),
      );
    }
    throw new HttpError(
      403,
      `The ${title(plan)} plan allows ${limit} open tunnels per account. Close one with \`tunnel close\`.` +
        (options.upgradeHint && plan === 'plus'
          ? ` Pro allows ${PLANS.pro.tunnels}: switch plans from Manage billing on your account page.`
          : ''),
    );
  }

  return {
    ofAccount,
    ofTunnel: (tunnelId) => owner(tunnelId).plan,
    limitsOf,
    tunnelsOf,
    accountTunnels,
    storedBytes,
    expires: (tunnelId, now = Date.now()) => now + limitsOf(owner(tunnelId).plan).historyDays * DAY,
    maxUpload: (tunnelId) => limitsOf(owner(tunnelId).plan).fileBytes + SEAL_OVERHEAD,
    checkTunnelCap,
    checkUpload,
    tooBig,
  };
}
```

- [ ] **Step 5: Update the message and file statements in `cli/src/relay/db.ts`**

In the statements object, replace `insertMessage`:

```ts
    insertMessage: q(
      'INSERT INTO messages (tunnel_id, seq, member_id, ct, created, expires) VALUES (?, ?, ?, ?, ?, ?)',
    ),
```

and replace the block from `insertFile` down to `deleteOldMessages` (keep `deleteExpiredInvites`) with:

```ts
    insertFile: q(
      'INSERT INTO files (id, tunnel_id, member_id, size, created, expires) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    file: q<{ id: string; tunnel_id: string; size: number }>('SELECT id, tunnel_id, size FROM files WHERE id = ?'),
    tunnelFiles: q<{ id: string }>('SELECT id FROM files WHERE tunnel_id = ?'),
    expiredFiles: q<{ id: string }>('SELECT id FROM files WHERE expires <= ?'),
    deleteExpiredFiles: q('DELETE FROM files WHERE expires <= ?'),
    deleteExpiredMessages: q('DELETE FROM messages WHERE expires <= ?'),
```

- [ ] **Step 6: Drop the fixed file limit from `cli/src/relay/http.ts`**

Delete the `fileBytes: 10 * 1024 * 1024 + 64,` line from `LIMITS`. Plans own that number now.

- [ ] **Step 7: Apply plans in `cli/src/relay/tunnels.ts`**

Replace the imports at the top with:

```ts
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { secretToken, sha256, shortId } from '../crypto.js';
import type { Member } from './db.js';
import { HttpError, LIMITS, bearer, json, send, str } from './http.js';
import type { App } from './server.js';
```

Change the signature to `export function tunnelRoutes(app: App) {` (no options).

Add this function under `removeTunnel`:

```ts
  /**
   * Stream the request body into a new file and return its size. Past `max` bytes the file is
   * removed and `tooBig()` is thrown. The request is not destroyed, so the 413 still reaches the
   * client (the server drains the rest of the body).
   */
  async function saveBody(req: IncomingMessage, path: string, max: number, tooBig: () => Error): Promise<number> {
    const out = createWriteStream(path, { flags: 'wx' });
    let size = 0;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += (chunk as Buffer).length;
        if (size > max) throw tooBig();
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end();
      await once(out, 'close');
      return size;
    } catch (error) {
      out.destroy();
      // Windows can't delete a file that is still open.
      if (!out.closed) await once(out, 'close');
      await unlink(path).catch(() => {});
      throw error;
    }
  }
```

Replace the `POST /v1/tunnels` route with:

```ts
  app.on('POST', '/v1/tunnels', async (req, res) => {
    const device = app.device(req);
    const input = await json<{ profile?: string }>(req);
    app.plans.checkTunnelCap(device);
    const now = Date.now();
    const tunnelId = shortId('t', 16);
    const memberId = shortId('m', 12);
    const token = secretToken();
    const profile = input.profile ? str(input.profile, 'profile', LIMITS.profileBytes) : null;
    store.insertTunnel.run(tunnelId, device.id, memberId, now);
    store.insertMember.run(memberId, tunnelId, sha256(token), profile, now, now);
    send(res, 201, { tunnelId, memberId, memberToken: token });
  });
```

In the `POST /v1/tunnels/:tid/messages` route, replace the insert line with:

```ts
    const now = Date.now();
    store.insertMessage.run(tid, row.seq, me.id, ct, now, app.plans.expires(tid, now));
```

Replace both file routes with:

```ts
  app.on('POST', '/v1/tunnels/:tid/files', async (req, res, [tid]) => {
    const me = member(req, tid);
    // Refuse a declared size over the limit before reading a byte of it.
    const declared = Number(req.headers['content-length']);
    if (declared > 0) app.plans.checkUpload(tid, declared);
    const id = shortId('f', 10);
    const path = join(app.filesDir, id);
    const size = await saveBody(req, path, app.plans.maxUpload(tid), () => app.plans.tooBig(tid));
    try {
      if (size === 0) throw new HttpError(400, 'Empty file.');
      // Chunked uploads have no Content-Length, so the storage check runs again on the real size.
      app.plans.checkUpload(tid, size);
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
    const now = Date.now();
    store.insertFile.run(id, tid, me.id, size, now, app.plans.expires(tid, now));
    send(res, 201, { fileId: id, size });
  });

  app.on('GET', '/v1/tunnels/:tid/files/:fid', async (req, res, [tid, fid]) => {
    member(req, tid);
    const file = store.file.get(fid);
    if (!file || file.tunnel_id !== tid) throw new HttpError(404, 'File not found. It may have expired.');
    const stream = createReadStream(join(app.filesDir, file.id));
    try {
      await once(stream, 'open');
    } catch {
      throw new HttpError(404, 'File not found. It may have expired.');
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size });
    // A client that hangs up mid-download is not an error worth logging.
    await pipeline(stream, res).catch(() => {});
  });
```

Replace the cleanup sweep with:

```ts
  app.sweeps.push(async () => {
    const now = Date.now();
    store.deleteExpiredInvites.run(now);
    store.deleteExpiredMessages.run(now);
    const expired = store.expiredFiles.all(now);
    store.deleteExpiredFiles.run(now);
    await Promise.all(expired.map((f) => unlink(join(app.filesDir, f.id)).catch(() => {})));
  });
```

- [ ] **Step 8: Wire plans into `cli/src/relay/server.ts`**

Add the import:

```ts
import { createPlans, type Plans } from './plans.js';
```

In `RelayOptions`, delete `ttlMs` and its comment. In `Relay`, add:

```ts
  /** Run the cleanup now instead of waiting for the 10-minute timer. */
  sweep(): Promise<void>;
```

In `App`, delete `maxTunnelsPerDevice` and add:

```ts
  plans: Plans;
```

Delete `const DAY = …`. In the `app` literal, replace `maxTunnelsPerDevice: options.maxTunnelsPerDevice ?? 0,` with:

```ts
    plans: createPlans(store, {
      freeCap: options.maxTunnelsPerDevice ?? 0,
      upgradeHint: Boolean(features.billing),
    }),
```

Change `const tunnels = tunnelRoutes(app, { ttlMs: options.ttlMs ?? 7 * DAY });` to `const tunnels = tunnelRoutes(app);`.

At the top of the request handler's `catch (error) {` block, before the `headersSent` check, add:

```ts
      // A handler may refuse before reading the body (an upload over the limit). Drain the rest,
      // or the client is still sending when the reply comes and sees a reset instead of the error.
      if (!req.complete) req.resume();
```

Replace the comment and the two timeout lines under `createServer` (`// long-polls hold requests open…`, `server.requestTimeout = …` and `server.keepAliveTimeout = 65_000;`) with:

```ts
  // A 100 MB upload on a slow link can take many minutes, so there is no total request time limit.
  // A socket that sends nothing for 2 minutes is dropped instead. Long-polls wait at most 55 s.
  server.requestTimeout = 0;
  server.timeout = 120_000;
  server.keepAliveTimeout = 65_000;
```

In the returned object, add `sweep,` above `async close()`.

- [ ] **Step 9: Let the relay decide file sizes in the CLI**

In `cli/src/commands.ts`, delete `const MAX_FILE_BYTES = 10 * 1024 * 1024;` and, in `sendCmd`, the line:

```ts
    if (size > MAX_FILE_BYTES) throw new UsageError(`${p} is ${formatSize(size)}. Files can be up to 10 MB.`);
```

In `cli/src/cli.ts`, change the `tunnel send` line of `HELP` to:

```
  tunnel send "text" [--to name] [--file path]...   Send a message, with files up to your plan's size limit
```

- [ ] **Step 10: Run the tests and the type check**

Run: `cd cli && node --import tsx --test test/plans.test.ts && npm test && npm run typecheck`
Expected: plans tests PASS (11 tests); full suite `# fail 0` (the original 19 included); no type errors.

- [ ] **Step 11: Commit**

```bash
git add cli/src/relay/plans.ts cli/src/relay/db.ts cli/src/relay/http.ts cli/src/relay/tunnels.ts cli/src/relay/server.ts cli/src/commands.ts cli/src/cli.ts cli/test/helpers.ts cli/test/plans.test.ts
git commit -m "feat(relay): per-plan tunnel caps, file sizes, storage and history; stream files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Stats counters, the page beacon and install counts

**Files:**
- Create: `cli/src/relay/stats.ts`
- Modify: `cli/src/relay/server.ts` (`App.stats`, active devices)
- Modify: `cli/src/relay/tunnels.ts` (counters, active members)
- Test: `cli/test/stats.test.ts`

**Interfaces:**
- Consumes: `App` (Tasks 1–3), `sha256` from `../crypto.js`.
- Produces:
  - `stats.ts`: `METRICS` (readonly tuple of the 14 metric names), `type Metric`, `interface Stats { count(metric: Metric, n?: number): void; active(kind: 'device' | 'member', id: string): void }`, `NO_STATS: Stats` (does nothing), `dayOf(at?: number): string` (UTC `YYYY-MM-DD`), `installMetric(path: string, userAgent: string): Metric | undefined`, `createStats(app: App): Stats` (also registers `POST /v1/hit`, `GET /internal/install` and a sweep).
  - `App.stats: Stats`. It is `NO_STATS` unless `features.adminEmails` is non-empty.

- [ ] **Step 1: Write the failing test, `cli/test/stats.test.ts`**

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/stats.test.ts`
Expected: FAIL, `Cannot find module '../src/relay/stats.js'`.

- [ ] **Step 3: Create `cli/src/relay/stats.ts`**

```ts
import { createHmac } from 'node:crypto';
import { sha256 } from '../crypto.js';
import { HttpError, body, send } from './http.js';
import type { App } from './server.js';

// Daily counters for the admin page. Nothing here identifies a person: visitor hashes are keyed by a
// salt that changes every day and are deleted when the day ends, and no address or cookie is stored.

export const METRICS = [
  'messages',
  'files',
  'file_bytes',
  'tunnels_opened',
  'joins',
  'devices_created',
  'signups',
  'logins',
  'checkouts',
  'page_views',
  'unique_visitors',
  'installs_sh',
  'installs_ps1',
  'installs_npm',
] as const;

export type Metric = (typeof METRICS)[number];

export interface Stats {
  count(metric: Metric, n?: number): void;
  /** Mark a machine (device token) or an agent (tunnel member) as active today. */
  active(kind: 'device' | 'member', id: string): void;
}

/** For relays without an admin: nothing is counted. */
export const NO_STATS: Stats = { count() {}, active() {} };

const DAY = 24 * 60 * 60 * 1000;
const BOT = /bot|crawl|spider|slurp|preview|headless/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The UTC day, as stored: 'YYYY-MM-DD'. */
export const dayOf = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);

/** Which install a download nginx mirrored to us counts as, if any. */
export function installMetric(path: string, userAgent: string): Metric | undefined {
  const file = path.split('?')[0];
  if (file === '/install.sh') return 'installs_sh';
  if (file === '/install.ps1') return 'installs_ps1';
  // The install scripts fetch the tarball with curl or PowerShell; only npm's own fetch is a separate install.
  if (/^\/tunnel-ai(-[\w.-]+)?\.tgz$/.test(file) && userAgent.startsWith('npm/')) return 'installs_npm';
  return undefined;
}

function referrerHost(raw: Buffer): string | undefined {
  try {
    const { r } = JSON.parse(raw.toString('utf8')) as { r?: unknown };
    if (typeof r !== 'string' || !r) return undefined;
    const url = new URL(r);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.slice(0, 253) : undefined;
  } catch {
    return undefined;
  }
}

export function createStats(app: App): Stats {
  const { store, features } = app;
  const s = {
    bump: store.prepare(
      `INSERT INTO stats_daily (day, metric, n) VALUES (?, ?, ?)
       ON CONFLICT(day, metric) DO UPDATE SET n = n + excluded.n`,
    ),
    device: store.prepare('INSERT OR IGNORE INTO active_devices (day, device_id) VALUES (?, ?)'),
    member: store.prepare('INSERT OR IGNORE INTO active_members (day, member_id) VALUES (?, ?)'),
    visitor: store.prepare('INSERT OR IGNORE INTO visitors (day, hash) VALUES (?, ?)'),
    referrer: store.prepare(
      'INSERT INTO referrers (day, host, n) VALUES (?, ?, 1) ON CONFLICT(day, host) DO UPDATE SET n = n + 1',
    ),
    dropVisitors: store.prepare('DELETE FROM visitors WHERE day < ?'),
    dropOld: [
      store.prepare('DELETE FROM active_devices WHERE day < ?'),
      store.prepare('DELETE FROM active_members WHERE day < ?'),
      store.prepare('DELETE FROM referrers WHERE day < ?'),
    ],
  };

  // Ids already written today, so a busy agent costs one insert a day, not one per request.
  let today = '';
  const seen = new Set<string>();

  const stats: Stats = {
    count(metric, n = 1) {
      if (n > 0) s.bump.run(dayOf(), metric, n);
    },
    active(kind, id) {
      const day = dayOf();
      if (day !== today) {
        today = day;
        seen.clear();
      }
      if (seen.has(id)) return;
      seen.add(id);
      (kind === 'device' ? s.device : s.member).run(day, id);
    },
  };

  const ownHost = features.publicUrl ? new URL(features.publicUrl).hostname : '';

  // The site sends {p, r} with navigator.sendBeacon as text/plain, so there is no CORS preflight.
  app.on('POST', '/v1/hit', async (req, res) => {
    const raw = await body(req, 4096);
    const userAgent = String(req.headers['user-agent'] ?? '');
    if (!userAgent || BOT.test(userAgent)) return send(res, 204);
    const day = dayOf();
    stats.count('page_views');
    if (features.statsSalt) {
      const dayKey = createHmac('sha256', features.statsSalt).update(day).digest('hex');
      const hash = sha256(`${dayKey}${app.clientOf(req)}\0${userAgent}`);
      if (Number(s.visitor.run(day, hash).changes) > 0) stats.count('unique_visitors');
    }
    const host = referrerHost(raw);
    if (host && host !== ownHost) s.referrer.run(day, host);
    send(res, 204);
  });

  // nginx mirrors install downloads here over loopback. Outside /v1/, so the public can't reach it
  // through the proxy; the socket check refuses anyone else who finds the port.
  app.on('GET', '/internal/install', async (req, res, _params, url) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) throw new HttpError(404, 'Not found.');
    const metric = installMetric(url.searchParams.get('f') ?? '', String(req.headers['user-agent'] ?? ''));
    if (metric) stats.count(metric);
    send(res, 204);
  });

  app.sweeps.push(() => {
    const now = Date.now();
    s.dropVisitors.run(dayOf(now));
    const cutoff = dayOf(now - 90 * DAY);
    for (const stmt of s.dropOld) stmt.run(cutoff);
  });

  return stats;
}
```

- [ ] **Step 4: Wire stats into `cli/src/relay/server.ts`**

Add the import:

```ts
import { createStats, NO_STATS, type Stats } from './stats.js';
```

In `App`, add:

```ts
  stats: Stats;
```

In the `app` literal, add `stats: NO_STATS,` and, in `device(req)`, call `app.stats.active('device', row.id);` just before `return row;`.

Right after the `app` literal (before the health route), add:

```ts
  // Stats feed the admin page, so they run only on a relay that has one.
  if (features.adminEmails.size > 0) app.stats = createStats(app);
```

- [ ] **Step 5: Count activity in `cli/src/relay/tunnels.ts`**

Add these calls (each on its own line):

- in `member()`, after the `touchMember` line: `app.stats.active('member', row.id);`
- in `POST /v1/devices`, before `send`: `app.stats.count('devices_created');`
- in `POST /v1/tunnels`, before `send`: `app.stats.count('tunnels_opened');`
- in `POST /v1/invites/:slot/claim`, before `send`: `app.stats.count('joins');`
- in `POST /v1/tunnels/:tid/messages`, after `wake(tid);`: `app.stats.count('messages');`
- in `POST /v1/tunnels/:tid/files`, after `store.insertFile.run(…)`:

```ts
    app.stats.count('files');
    app.stats.count('file_bytes', size);
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd cli && node --import tsx --test test/stats.test.ts && npm test && npm run typecheck`
Expected: stats tests PASS (8 tests); full suite `# fail 0`; no type errors.

- [ ] **Step 7: Commit**

```bash
git add cli/src/relay/stats.ts cli/src/relay/server.ts cli/src/relay/tunnels.ts cli/test/stats.test.ts
git commit -m "feat(relay): cookieless daily stats, page beacon and install counts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Accounts, sessions and email sign-in

**Files:**
- Modify: `cli/src/relay/http.ts` (cookies, redirects, `safeReturn`, sign-in limits)
- Create: `cli/src/relay/accounts.ts`
- Create: `cli/src/relay/auth-email.ts`
- Modify: `cli/src/relay/server.ts` (wiring)
- Modify: `cli/test/helpers.ts` (`outbound`, `browser`, `follow`, `signIn`)
- Test: `cli/test/accounts.test.ts`

**Interfaces:**
- Consumes: `App` with `plans` and `stats` (Tasks 1–4), `Account` (Task 2), `secretToken`, `sha256`, `shortId` from `../crypto.js`.
- Produces:
  - `http.ts`: `LIMITS.loginEmailsPerAddress = 5`, `LIMITS.loginEmailsPerClient = 20`, `cookies(req): Record<string, string>`, `setCookie(name, value, maxAgeS, { secure, httpOnly }): string`, `redirect(res, location, setCookies?: string[])`, `safeReturn(value: unknown): string`.
  - `accounts.ts`: `SESSION_COOKIE = 'tunnel_session'`, `HINT_COOKIE = 'tunnel_signed_in'`, `interface Accounts { byId; session; requireSession; requireOrigin; startSession(accountId): string[]; upsertByEmail(email): Account; upsertGithub({ id, login, email }): Account; isAdmin(account): boolean }`, `accountRoutes(app): Accounts`. Routes: `GET /v1/auth/methods`, `POST /v1/auth/logout`, `GET /v1/account`, `POST /v1/account/devices/:id/unlink`.
  - `auth-email.ts`: `normalizeEmail(value): string`, `emailRoutes(app, accounts, config: { apiKey; from })`. Routes: `POST /v1/auth/email`, `GET /v1/auth/email/verify`, `POST /v1/auth/email/verify`.
  - `GET /v1/account` answers `{ email, githubLogin, plan, planSource, planUntil, limits, usage: { tunnels, storageBytes }, devices: [{ id, created, seen, tunnels }], subscription: null, admin }` (Task 8 fills `subscription`).
  - `test/helpers.ts`: `type Route`, `outbound(routes?) → { fetch, calls, table, lastLink() }`, `type Outbound`, `browser(relay, origin = PUBLIC_URL) → { jar, request, get, post }`, `type Browser`, `type Page = { status; headers; body }`, `follow(b, link): Promise<Page>`, `signIn(b, out, email, returnTo?): Promise<string>`.

- [ ] **Step 1: Add the browser and outbound helpers to `cli/test/helpers.ts`**

Add `import assert from 'node:assert/strict';` to the imports, and append:

```ts
export type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
export type Outbound = ReturnType<typeof outbound>;

/**
 * Stands in for GitHub, Resend and Lemon Squeezy. A request goes to the route with the longest
 * matching URL prefix; anything unmatched gets a 599. Tests may swap entries in `table`.
 */
export function outbound(routes: Record<string, Route> = {}) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const table: Record<string, Route> = {
    'https://api.resend.com/emails': () => Response.json({ id: 'email_1' }),
    ...routes,
  };
  const stub = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    let body: any = init.body;
    try {
      body = JSON.parse(String(init.body));
    } catch {
      // not JSON; keep it as sent
    }
    calls.push({ url, init, body });
    const prefix = Object.keys(table)
      .filter((p) => url.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ? table[prefix](url, init) : new Response(`no stub for ${url}`, { status: 599 });
  }) as typeof fetch;
  return {
    fetch: stub,
    calls,
    table,
    /** The sign-in link in the newest email. */
    lastLink(): string {
      const mail = calls.filter((c) => c.url === 'https://api.resend.com/emails').at(-1);
      const match = /https?:\/\/\S+/.exec(mail?.body?.text ?? '');
      if (!match) throw new Error('No sign-in email was sent.');
      return match[0];
    },
  };
}

export interface Page {
  status: number;
  headers: Headers;
  body: any;
}

export type Browser = ReturnType<typeof browser>;

/** A browser on `origin`: keeps cookies, sends Origin on POSTs, and does not follow redirects. */
export function browser(r: { url: string }, origin = PUBLIC_URL) {
  const jar = new Map<string, string>();
  async function request(method: string, path: string, data?: unknown): Promise<Page> {
    const headers: Record<string, string> = {};
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') headers.origin = origin;
    if (data !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(r.url + path, {
      method,
      headers,
      redirect: 'manual',
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      if (attributes.some((a) => a.trim() === 'Max-Age=0')) jar.delete(name);
      else jar.set(name, pair.slice(i + 1));
    }
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, body };
  }
  return {
    jar,
    request,
    get: (path: string) => request('GET', path),
    post: (path: string, data: unknown = {}) => request('POST', path, data),
  };
}

/** Open an emailed sign-in link in this browser, as the account page does. */
export async function follow(b: Browser, link: string): Promise<Page> {
  const url = new URL(link);
  const landing = await b.get(url.pathname + url.search);
  const token = new URL(landing.headers.get('location') ?? '/', PUBLIC_URL).searchParams.get('login');
  return b.post('/v1/auth/email/verify', { token });
}

/** Sign in by email. Returns the path the account page should go to next. */
export async function signIn(b: Browser, out: Outbound, email: string, returnTo?: string): Promise<string> {
  const ask = await b.post('/v1/auth/email', { email, return: returnTo });
  assert.equal(ask.status, 202, JSON.stringify(ask.body));
  const done = await follow(b, out.lastLink());
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.returnTo;
}
```

- [ ] **Step 2: Write the failing test, `cli/test/accounts.test.ts`**

```ts
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturn } from '../src/relay/http.js';
import { FULL_ENV, PUBLIC_URL, browser, follow, outbound, relay, signIn, sql, type TestRelay } from './helpers.js';

describe('email sign-in', () => {
  const out = outbound();
  let r: TestRelay;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch });
  });
  after(() => r.close());

  test('methods lists the sign-in options this relay has', async () => {
    assert.deepEqual((await browser(r).get('/v1/auth/methods')).body, { github: true, email: true, billing: true });
  });

  test('the emailed link signs you in with a 30-day HttpOnly cookie', async () => {
    const b = browser(r);
    const ask = await b.post('/v1/auth/email', { email: ' Ada@Example.com ', return: '/account?plan=pro' });
    assert.equal(ask.status, 202);
    const mail = out.calls.at(-1)!;
    assert.equal(mail.url, 'https://api.resend.com/emails');
    assert.deepEqual(mail.body.to, ['ada@example.com']);
    assert.equal(mail.body.from, FULL_ENV.TUNNEL_EMAIL_FROM);
    assert.equal(new Headers(mail.init.headers).get('authorization'), 'Bearer re_test');

    const link = new URL(out.lastLink());
    assert.equal(link.origin + link.pathname, `${PUBLIC_URL}/v1/auth/email/verify`);
    const done = await follow(b, link.href);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { returnTo: '/account?plan=pro' });
    const [session, hint] = done.headers.getSetCookie();
    assert.match(session, /^tunnel_session=[\w-]{43}; Path=\/; Max-Age=2592000; SameSite=Lax; HttpOnly$/);
    assert.equal(hint, 'tunnel_signed_in=1; Path=/; Max-Age=2592000; SameSite=Lax');

    const me = await b.get('/v1/account');
    assert.equal(me.status, 200);
    assert.equal(me.body.email, 'ada@example.com');
    assert.equal(me.body.plan, 'free');
    assert.equal(me.body.limits.fileBytes, 10 * 1024 * 1024);
    assert.deepEqual(me.body.usage, { tunnels: 0, storageBytes: 0 });
    assert.deepEqual(me.body.devices, []);
    assert.equal(me.body.subscription, null);
    assert.equal(me.body.admin, false);
  });

  test('a mail scanner opening the link does not use it up', async () => {
    assert.equal((await browser(r).post('/v1/auth/email', { email: 'scan@example.com' })).status, 202);
    const link = out.lastLink();
    for (let i = 0; i < 2; i++) {
      const scan = await fetch(link.replace(PUBLIC_URL, r.url), { redirect: 'manual' });
      assert.equal(scan.status, 302);
      assert.deepEqual(scan.headers.getSetCookie(), []);
    }
    const b = browser(r);
    assert.equal((await follow(b, link)).status, 200);
    assert.equal((await b.get('/v1/account')).body.email, 'scan@example.com');
    const again = await follow(browser(r), link);
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'This sign-in link expired or was already used. Ask for a new one.');
  });

  test('an expired link is refused', async () => {
    const b = browser(r);
    assert.equal((await b.post('/v1/auth/email', { email: 'late@example.com' })).status, 202);
    await sql(r.dataDir, 'UPDATE email_logins SET expires = 1');
    assert.equal((await follow(b, out.lastLink())).status, 410);
  });

  test('return_to only accepts paths on this site', async () => {
    const bad = ['//evil.com', '/\\evil.com', '/\tevil.com', 'https://evil.com/', 'javascript:alert(1)', 'account', '/' + 'a'.repeat(600)];
    for (const value of bad) assert.equal(safeReturn(value), '/account', JSON.stringify(value));
    assert.equal(safeReturn(undefined), '/account');
    assert.equal(safeReturn('/account?plan=plus&link=ABCD-EFGH'), '/account?plan=plus&link=ABCD-EFGH');
    // And end to end, through an emailed link:
    assert.equal(await signIn(browser(r), out, 'away@example.com', '//evil.com'), '/account');
    assert.equal(await signIn(browser(r), out, 'home@example.com', '/\\evil.com'), '/account');
  });

  test('POSTs from another site are refused', async () => {
    const evil = browser(r, 'https://evil.example');
    for (const path of ['/v1/auth/email', '/v1/auth/email/verify', '/v1/auth/logout']) {
      const res = await evil.post(path, { email: 'x@example.com', token: 'x' });
      assert.equal(res.status, 403, path);
      assert.equal(res.body.error, 'This request came from another site, so it was blocked.');
    }
  });

  test('signing out ends the session for good', async () => {
    const b = browser(r);
    await signIn(b, out, 'bye@example.com');
    const cookie = b.jar.get('tunnel_session')!;
    assert.equal((await b.post('/v1/auth/logout')).status, 204);
    assert.equal(b.jar.size, 0);
    const old = await fetch(`${r.url}/v1/account`, { headers: { cookie: `tunnel_session=${cookie}` } });
    assert.equal(old.status, 401);
    assert.deepEqual(await old.json(), { error: 'Sign in first.' });
  });

  test('a bad address gets a plain 400', async () => {
    const res = await browser(r).post('/v1/auth/email', { email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Enter a valid email address.');
  });

  test('when the email cannot be sent, the person is told and no link is left behind', async () => {
    const resend = out.table['https://api.resend.com/emails'];
    out.table['https://api.resend.com/emails'] = () => new Response('down', { status: 500 });
    try {
      const res = await browser(r).post('/v1/auth/email', { email: 'nomail@example.com' });
      assert.equal(res.status, 502);
      assert.equal(res.body.error, "Couldn't send the email. Try again or sign in with GitHub.");
      assert.deepEqual(await sql(r.dataDir, "SELECT * FROM email_logins WHERE email = 'nomail@example.com'"), []);
    } finally {
      out.table['https://api.resend.com/emails'] = resend;
    }
  });

  test('you can only unlink machines on your own account', async () => {
    const b = browser(r);
    await signIn(b, out, 'owner@example.com');
    const res = await b.post('/v1/account/devices/d_someone/unlink');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "That machine isn't linked to your account.");
  });
});

describe('sign-in email limits', () => {
  test('one address gets at most 5 links an hour', async () => {
    const out = outbound();
    const r = await relay({ env: FULL_ENV, fetch: out.fetch });
    try {
      const b = browser(r);
      for (let i = 0; i < 5; i++) {
        assert.equal((await b.post('/v1/auth/email', { email: 'many@example.com' })).status, 202);
      }
      const sixth = await b.post('/v1/auth/email', { email: 'many@example.com' });
      assert.equal(sixth.status, 429);
      assert.match(sixth.body.error, /for this address/);
      assert.equal((await b.post('/v1/auth/email', { email: 'other@example.com' })).status, 202);
    } finally {
      await r.close();
    }
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/accounts.test.ts`
Expected: FAIL, `safeReturn` is not exported from `../src/relay/http.js` (a SyntaxError on import).

- [ ] **Step 4: Add the cookie, redirect and return-path helpers to `cli/src/relay/http.ts`**

Add two entries to `LIMITS`:

```ts
  loginEmailsPerAddress: 5,
  loginEmailsPerClient: 20,
```

Append:

```ts
/** Cookies sent with the request. Ours are base64url or "1", so values are used as sent. */
export function cookies(req: IncomingMessage): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return jar;
}

/** A Set-Cookie value. Max-Age 0 deletes the cookie. */
export function setCookie(name: string, value: string, maxAgeS: number, options: { secure: boolean; httpOnly: boolean }) {
  const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${maxAgeS}`, 'SameSite=Lax'];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function redirect(res: ServerResponse, location: string, setCookies: string[] = []) {
  const headers: OutgoingHttpHeaders = { location, 'cache-control': 'no-store' };
  if (setCookies.length) headers['set-cookie'] = setCookies;
  res.writeHead(302, headers).end();
}

/**
 * Where to send someone after sign-in: a path on this site, else /account. "//host" and "/\host"
 * are other sites to a browser, and browsers drop tabs and newlines, so "/<tab>/host" is one too.
 */
export function safeReturn(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return '/account';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return '/account';
  return value;
}
```

- [ ] **Step 5: Create `cli/src/relay/accounts.ts`**

```ts
import type { IncomingMessage } from 'node:http';
import { secretToken, sha256, shortId } from '../crypto.js';
import type { Account } from './db.js';
import { HttpError, cookies, send, setCookie } from './http.js';
import type { App } from './server.js';

// Accounts are optional: a device works without one. An account holds the plan and the machines
// linked to it, and a browser reaches it through a session cookie.

export const SESSION_COOKIE = 'tunnel_session';
/** Not secret. Lets static pages show "Account" instead of "Sign in" without asking the relay. */
export const HINT_COOKIE = 'tunnel_signed_in';
const SESSION_S = 30 * 24 * 60 * 60;
const HOUR = 60 * 60 * 1000;

export interface Accounts {
  byId(id: string): Account | undefined;
  /** The signed-in account, if the session cookie is valid. */
  session(req: IncomingMessage): Account | undefined;
  /** The signed-in account, or a 401. */
  requireSession(req: IncomingMessage): Account;
  /** Browser POSTs must come from our own pages, or a 403. */
  requireOrigin(req: IncomingMessage): void;
  /** A new session for this account, as Set-Cookie values. */
  startSession(accountId: string): string[];
  upsertByEmail(email: string): Account;
  /** The account with this GitHub id, else the one with this email, else a new one. */
  upsertGithub(user: { id: number; login: string; email: string }): Account;
  isAdmin(account: Account): boolean;
}

export function accountRoutes(app: App): Accounts {
  const { store, features } = app;
  // server.ts only calls this when a public URL is set.
  const publicUrl = features.publicUrl!;
  const secure = !publicUrl.startsWith('http://');

  const s = {
    byId: store.prepare<Account>('SELECT * FROM accounts WHERE id = ?'),
    byEmail: store.prepare<Account>('SELECT * FROM accounts WHERE email = ?'),
    byGithub: store.prepare<Account>('SELECT * FROM accounts WHERE github_id = ?'),
    create: store.prepare(
      'INSERT INTO accounts (id, email, created, seen) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING',
    ),
    setGithub: store.prepare('UPDATE accounts SET github_id = ?, github_login = ? WHERE id = ?'),
    touch: store.prepare('UPDATE accounts SET seen = ? WHERE id = ?'),
    session: store.prepare<Account>(
      'SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?',
    ),
    insertSession: store.prepare('INSERT INTO sessions (token_hash, account_id, created, expires) VALUES (?, ?, ?, ?)'),
    deleteSession: store.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    devices: store.prepare<{ id: string; created: number; seen: number | null; tunnels: number }>(
      `SELECT d.id, d.created, d.seen, (SELECT COUNT(*) FROM tunnels t WHERE t.owner_device = d.id) AS tunnels
         FROM devices d WHERE d.account_id = ? ORDER BY d.created`,
    ),
    unlink: store.prepare('UPDATE devices SET account_id = NULL WHERE id = ? AND account_id = ?'),
    expired: [
      store.prepare('DELETE FROM sessions WHERE expires <= ?'),
      store.prepare('DELETE FROM email_logins WHERE expires <= ?'),
      store.prepare('DELETE FROM oauth_states WHERE expires <= ?'),
      store.prepare('DELETE FROM device_links WHERE expires <= ?'),
    ],
  };

  function create(email: string): Account {
    const now = Date.now();
    if (Number(s.create.run(shortId('a', 12), email, now, now).changes) > 0) app.stats.count('signups');
    return s.byEmail.get(email)!;
  }

  const accounts: Accounts = {
    byId: (id) => s.byId.get(id),
    session(req) {
      const token = cookies(req)[SESSION_COOKIE];
      if (!token) return undefined;
      const now = Date.now();
      const account = s.session.get(sha256(token), now);
      if (account && now - account.seen > HOUR) s.touch.run(now, account.id);
      return account;
    },
    requireSession(req) {
      const account = accounts.session(req);
      if (!account) throw new HttpError(401, 'Sign in first.');
      return account;
    },
    requireOrigin(req) {
      if (req.headers.origin !== publicUrl) {
        throw new HttpError(403, 'This request came from another site, so it was blocked.');
      }
    },
    startSession(accountId) {
      const token = secretToken();
      const now = Date.now();
      s.insertSession.run(sha256(token), accountId, now, now + SESSION_S * 1000);
      app.stats.count('logins');
      return [
        setCookie(SESSION_COOKIE, token, SESSION_S, { secure, httpOnly: true }),
        setCookie(HINT_COOKIE, '1', SESSION_S, { secure, httpOnly: false }),
      ];
    },
    upsertByEmail: (email) => s.byEmail.get(email) ?? create(email),
    upsertGithub(user) {
      const account = s.byGithub.get(user.id) ?? s.byEmail.get(user.email) ?? create(user.email);
      s.setGithub.run(user.id, user.login, account.id);
      return s.byId.get(account.id)!;
    },
    isAdmin: (account) => features.adminEmails.has(account.email),
  };

  app.on('GET', '/v1/auth/methods', async (_req, res) =>
    send(res, 200, { github: Boolean(features.github), email: Boolean(features.email), billing: Boolean(features.billing) }),
  );

  app.on('POST', '/v1/auth/logout', async (req, res) => {
    accounts.requireOrigin(req);
    const token = cookies(req)[SESSION_COOKIE];
    if (token) s.deleteSession.run(sha256(token));
    send(res, 204, undefined, {
      'set-cookie': [
        setCookie(SESSION_COOKIE, '', 0, { secure, httpOnly: true }),
        setCookie(HINT_COOKIE, '', 0, { secure, httpOnly: false }),
      ],
    });
  });

  app.on('GET', '/v1/account', async (req, res) => {
    const account = accounts.requireSession(req);
    send(res, 200, {
      email: account.email,
      githubLogin: account.github_login,
      plan: account.plan,
      planSource: account.plan_source,
      planUntil: account.plan_until,
      limits: app.plans.limitsOf(account.plan),
      usage: { tunnels: app.plans.accountTunnels(account.id), storageBytes: app.plans.storedBytes(account.id) },
      devices: s.devices.all(account.id),
      subscription: null,
      admin: accounts.isAdmin(account),
    });
  });

  app.on('POST', '/v1/account/devices/:id/unlink', async (req, res, [id]) => {
    accounts.requireOrigin(req);
    const account = accounts.requireSession(req);
    if (Number(s.unlink.run(id, account.id).changes) === 0) {
      throw new HttpError(404, "That machine isn't linked to your account.");
    }
    send(res, 204);
  });

  app.sweeps.push(() => {
    const now = Date.now();
    for (const stmt of s.expired) stmt.run(now);
  });

  return accounts;
}
```

- [ ] **Step 6: Create `cli/src/relay/auth-email.ts`**

```ts
import { secretToken, sha256 } from '../crypto.js';
import type { Accounts } from './accounts.js';
import type { Features } from './config.js';
import { HttpError, LIMITS, json, redirect, safeReturn, send } from './http.js';
import type { App } from './server.js';

// Sign-in by email: the relay mails a one-time link through Resend.

const LINK_MS = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return email;
}

export function emailRoutes(app: App, accounts: Accounts, config: NonNullable<Features['email']>) {
  const publicUrl = app.features.publicUrl!;
  const s = {
    insert: app.store.prepare('INSERT INTO email_logins (token_hash, email, return_to, expires) VALUES (?, ?, ?, ?)'),
    drop: app.store.prepare('DELETE FROM email_logins WHERE token_hash = ?'),
    // Spending a link deletes it, so it works once.
    take: app.store.prepare<{ email: string; return_to: string }>(
      'DELETE FROM email_logins WHERE token_hash = ? AND expires > ? RETURNING email, return_to',
    ),
  };
  const perClient = app.counter(
    HOUR,
    LIMITS.loginEmailsPerClient,
    'Too many sign-in emails from this network. Try again in an hour.',
  );
  const perAddress = app.counter(
    HOUR,
    LIMITS.loginEmailsPerAddress,
    'Too many sign-in emails for this address. Use the newest one, or try again in an hour.',
  );

  app.on('POST', '/v1/auth/email', async (req, res) => {
    accounts.requireOrigin(req);
    const input = await json<{ email?: unknown; return?: unknown }>(req);
    const email = normalizeEmail(input.email);
    perClient(req);
    perAddress(req, email);
    const token = secretToken();
    const hash = sha256(token);
    s.insert.run(hash, email, safeReturn(input.return), Date.now() + LINK_MS);
    const link = `${publicUrl}/v1/auth/email/verify?token=${token}`;
    try {
      const reply = await app.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: config.from,
          to: [email],
          subject: 'Your tunnel sign-in link',
          text:
            `Open this link to sign in to tunnel:\n\n${link}\n\n` +
            "It works once, for 15 minutes. If you didn't ask for it, ignore this email.\n",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!reply.ok) throw new Error(`Resend answered ${reply.status}`);
    } catch (error) {
      s.drop.run(hash);
      app.log(`Sign-in email failed: ${(error as Error).message}`);
      throw new HttpError(502, "Couldn't send the email. Try again or sign in with GitHub.");
    }
    // The same answer whether or not an account exists for this address.
    send(res, 202, { ok: true });
  });

  // Mail scanners open links to check them. This GET only hands the token to the account page,
  // which spends it with the POST below, so a scanner can't use the link up.
  app.on('GET', '/v1/auth/email/verify', async (_req, res, _params, url) => {
    redirect(res, `/account?login=${encodeURIComponent(url.searchParams.get('token') ?? '')}`);
  });

  app.on('POST', '/v1/auth/email/verify', async (req, res) => {
    accounts.requireOrigin(req);
    const input = await json<{ token?: unknown }>(req);
    const login =
      typeof input.token === 'string' && input.token ? s.take.get(sha256(input.token), Date.now()) : undefined;
    if (!login) throw new HttpError(410, 'This sign-in link expired or was already used. Ask for a new one.');
    const account = accounts.upsertByEmail(login.email);
    send(res, 200, { returnTo: login.return_to }, { 'set-cookie': accounts.startSession(account.id) });
  });
}
```

- [ ] **Step 7: Wire accounts into `cli/src/relay/server.ts`**

Add the imports:

```ts
import { accountRoutes } from './accounts.js';
import { emailRoutes } from './auth-email.js';
```

Right after `const tunnels = tunnelRoutes(app);`, add:

```ts
  if (features.publicUrl) {
    const accounts = accountRoutes(app);
    if (features.email) emailRoutes(app, accounts, features.email);
  }
```

- [ ] **Step 8: Run the tests and the type check**

Run: `cd cli && node --import tsx --test test/accounts.test.ts && npm test && npm run typecheck`
Expected: accounts tests PASS (11 tests); full suite `# fail 0`; no type errors.

- [ ] **Step 9: Commit**

```bash
git add cli/src/relay/http.ts cli/src/relay/accounts.ts cli/src/relay/auth-email.ts cli/src/relay/server.ts cli/test/helpers.ts cli/test/accounts.test.ts
git commit -m "feat(relay): accounts, sessions and email sign-in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: GitHub sign-in

**Files:**
- Create: `cli/src/relay/auth-github.ts`
- Modify: `cli/src/relay/server.ts` (wiring)
- Test: `cli/test/github.test.ts`

**Interfaces:**
- Consumes: `Accounts.upsertGithub`, `Accounts.startSession` (Task 5); `cookies`, `redirect`, `safeReturn`, `setCookie` (Task 5); `app.fetch`, `app.log`.
- Produces: `githubRoutes(app, accounts, config: { clientId; clientSecret })`. Routes: `GET /v1/auth/github/start?return=…` and `GET /v1/auth/github/callback`. Failures redirect to `/account?error=` with one of `github-state`, `github-denied`, `github`, `github-email` (the account page in Task 11 shows a sentence for each).

- [ ] **Step 1: Write the failing test, `cli/test/github.test.ts`**

```ts
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
    assert.equal(authorize.searchParams.get('scope'), 'read:user user:email');
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
    const state = await stateOf(browser(r));
    const victim = browser(r);
    assert.equal(await back(victim, `code=abc&state=${state}`), '/account?error=github-state');
    assert.equal(victim.jar.has('tunnel_session'), false);
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/github.test.ts`
Expected: FAIL. `start` asserts 302 and gets 404 (`GET /v1/auth/github/start` doesn't exist yet).

- [ ] **Step 3: Create `cli/src/relay/auth-github.ts`**

```ts
import { secretToken, sha256 } from '../crypto.js';
import type { Accounts } from './accounts.js';
import type { Features } from './config.js';
import { cookies, redirect, safeReturn, setCookie } from './http.js';
import type { App } from './server.js';

// Sign-in with GitHub (OAuth web flow). The state is stored hashed for 10 minutes and must also
// match a cookie in the same browser, so nobody can finish a sign-in that someone else started.

const STATE_COOKIE = 'tunnel_oauth';
const STATE_S = 10 * 60;

export function githubRoutes(app: App, accounts: Accounts, config: NonNullable<Features['github']>) {
  const publicUrl = app.features.publicUrl!;
  const secure = !publicUrl.startsWith('http://');
  const callbackUrl = `${publicUrl}/v1/auth/github/callback`;
  const s = {
    insert: app.store.prepare('INSERT INTO oauth_states (state, return_to, expires) VALUES (?, ?, ?)'),
    take: app.store.prepare<{ return_to: string }>(
      'DELETE FROM oauth_states WHERE state = ? AND expires > ? RETURNING return_to',
    ),
  };
  const clearState = setCookie(STATE_COOKIE, '', 0, { secure, httpOnly: true });

  app.on('GET', '/v1/auth/github/start', async (_req, res, _params, url) => {
    const state = secretToken();
    s.insert.run(sha256(state), safeReturn(url.searchParams.get('return')), Date.now() + STATE_S * 1000);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: callbackUrl,
      scope: 'read:user user:email',
      state,
    }).toString();
    redirect(res, authorize.href, [setCookie(STATE_COOKIE, state, STATE_S, { secure, httpOnly: true })]);
  });

  app.on('GET', '/v1/auth/github/callback', async (req, res, _params, url) => {
    const fail = (code: string) => redirect(res, `/account?error=${code}`, [clearState]);
    const state = url.searchParams.get('state') ?? '';
    if (!state || cookies(req)[STATE_COOKIE] !== state) return fail('github-state');
    const pending = s.take.get(sha256(state), Date.now());
    if (!pending) return fail('github-state');
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) return fail('github-denied');
    let user: { id: number; login: string; email: string } | undefined;
    try {
      user = await fetchUser(code);
    } catch (error) {
      app.log(`GitHub sign-in failed: ${(error as Error).message}`);
      return fail('github');
    }
    if (!user) return fail('github-email');
    const account = accounts.upsertGithub(user);
    redirect(res, pending.return_to, [clearState, ...accounts.startSession(account.id)]);
  });

  /** The GitHub user behind this code, or undefined when they have no verified primary email. */
  async function fetchUser(code: string) {
    const token = await call<{ access_token?: string; error?: string }>('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });
    if (!token.access_token) throw new Error(`no access token (${token.error ?? 'no error given'})`);
    const headers = {
      authorization: `Bearer ${token.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'tunnel-relay',
    };
    const profile = await call<{ id: number; login: string }>('https://api.github.com/user', { headers });
    const emails = await call<{ email: string; primary: boolean; verified: boolean }[]>(
      'https://api.github.com/user/emails',
      { headers },
    );
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) return undefined;
    return { id: profile.id, login: profile.login, email: primary.email.toLowerCase() };
  }

  async function call<T>(url: string, init: RequestInit): Promise<T> {
    const res = await app.fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
    return (await res.json()) as T;
  }
}
```

- [ ] **Step 4: Wire it into `cli/src/relay/server.ts`**

Add `import { githubRoutes } from './auth-github.js';`, and inside the `if (features.publicUrl) {` block, after the email line:

```ts
    if (features.github) githubRoutes(app, accounts, features.github);
```

- [ ] **Step 5: Run the tests and the type check**

Run: `cd cli && node --import tsx --test test/github.test.ts && npm test && npm run typecheck`
Expected: GitHub tests PASS (6 tests); full suite `# fail 0`; no type errors.

- [ ] **Step 6: Commit**

```bash
git add cli/src/relay/auth-github.ts cli/src/relay/server.ts cli/test/github.test.ts
git commit -m "feat(relay): GitHub sign-in" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Linking machines: `tunnel login`, `logout` and `account`

**Files:**
- Modify: `cli/src/relay/accounts.ts` (append `normalizeCode`, `formatCode`, `linkRoutes`)
- Modify: `cli/src/relay/server.ts` (wiring)
- Modify: `cli/src/commands.ts` (`IO.openUrl`, export `relayFor` and `sleep`, new `withDevice`, `openCmd` uses it)
- Create: `cli/src/account-commands.ts`
- Modify: `cli/src/cli.ts` (commands and help)
- Modify: `cli/src/bin.ts` (`openUrl`)
- Modify: `cli/test/helpers.ts` (`agent` records opened links, `until`, `linkMachine`)
- Test: `cli/test/link.test.ts`

**Interfaces:**
- Consumes: `Accounts` (Task 5), `App.plans.tunnelsOf/limitsOf/storedBytes` (Task 3), `formatBytes`, `title`, `Limits`, `PlanName` from `relay/plans.ts` (Task 3), `browser`, `signIn`, `outbound` (Task 5).
- Produces:
  - `accounts.ts`: `normalizeCode(value: unknown): string` (upper case, letters and digits only), `formatCode(code: string): string` (`ABCD-EFGH`), `linkRoutes(app: App, accounts: Accounts): void`.
  - Routes:
    - `POST /v1/auth/device` (device token) → 201 `{ userCode, verifyUrl, pollToken, expiresIn: 600, interval }`
    - `POST /v1/auth/device/poll { pollToken }` → 202 `{ status: 'pending' }`, 200 `{ email, plan }` or 410
    - `POST /v1/account/devices/link { userCode }` (session, Origin) → 204 or 404; 429 after 20 tries per account in 10 minutes
    - `GET /v1/devices/me` (device token) → `{ deviceId, account: { email } | null, plan, limits, usage: { tunnels, storageBytes } }`
    - `POST /v1/devices/me/unlink` (device token) → 200 `{ email: string | null }`
  - `commands.ts`: `IO.openUrl?(url: string): void`; exported `relayFor(ctx): string`, `sleep(ms, signal?)`, `withDevice<T>(ctx, relay, fn: (client: RelayClient) => Promise<T>): Promise<T>` (registers a device if needed and retries once on 401).
  - `account-commands.ts`: `loginCmd(ctx)`, `logoutCmd(ctx)`, `accountCmd(ctx)`, and the private helpers `asDevice<T>(ctx, relay, method, path, data, missing): Promise<T>` and `noAccounts(relay): string` that Task 8 reuses.
  - `test/helpers.ts`: `Agent` gains `opened: string[]`; `until<T>(fn, ms = 5000): Promise<T>`; `linkMachine(a: Agent, b: Browser, ...flags: string[])` returns the finished `tunnel login` run.

- [ ] **Step 1: Extend the test helpers in `cli/test/helpers.ts`**

Replace the `agent` function with this version (it records every link the CLI asks to open):

```ts
/** One machine running the CLI against a relay, with its own ~/.tunnel. */
export function agent(relayOf: () => { url: string }, label: string) {
  const home = tmp(label);
  const cwd = tmp(`${label}-cwd`);
  const opened: string[] = [];
  const read = <T>(file: string) => JSON.parse(readFileSync(join(home, file), 'utf8')) as T;
  return {
    home,
    cwd,
    /** Links the CLI asked to open in a browser, oldest first. */
    opened,
    async run(...argv: string[]) {
      let out = '';
      let err = '';
      const code = await run(argv, {
        env: { TUNNEL_HOME: home, TUNNEL_RELAY: relayOf().url },
        cwd,
        out: (s) => (out += s + '\n'),
        err: (s) => (err += s + '\n'),
        openUrl: (url) => opened.push(url),
      });
      return { code, out, err };
    },
    deviceId: () => read<{ devices: Record<string, { id: string }> }>('config.json').devices[relayOf().url].id,
    tunnel: (name: string) => read<Record<string, TunnelRecord>>('tunnels.json')[name],
  };
}
```

Append:

```ts
/** Poll until `fn` returns something truthy. */
export async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Nothing after ${ms} ms.`);
    await sleep(10);
  }
}

/**
 * Run `tunnel login` on `a` and confirm its code in browser `b`, as a person would.
 * Use a relay started with a small `linkPollSeconds`. Returns the finished login run.
 */
export async function linkMachine(a: Agent, b: Browser, ...flags: string[]) {
  const before = a.opened.length;
  const login = a.run('login', ...flags);
  const url = await until(() => a.opened[before]);
  const userCode = new URL(url).searchParams.get('link');
  const res = await b.post('/v1/account/devices/link', { userCode });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  return login;
}
```

- [ ] **Step 2: Write the failing test, `cli/test/link.test.ts`**

```ts
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/link.test.ts`
Expected: FAIL. `normalizeCode` is not exported from `../src/relay/accounts.js` (a SyntaxError on import), and `npm run typecheck` reports that `openUrl` is not in `IO`.

- [ ] **Step 4: Append the linking routes to `cli/src/relay/accounts.ts`**

Add `import { randomInt } from 'node:crypto';` at the top, and add `json` to the import from `./http.js`:

```ts
import { HttpError, cookies, json, send, setCookie } from './http.js';
```

Append to the end of the file:

```ts
// ---------- linking machines (tunnel login) ----------

/** No 0/O, 1/I/L or U, so a code read aloud or retyped comes out the same. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LINK_S = 10 * 60;

/** A code as stored: upper case, letters and digits only. */
export const normalizeCode = (value: unknown) =>
  typeof value === 'string' ? value.toUpperCase().replace(/[^0-9A-Z]/g, '') : '';

/** A stored code as people see it: ABCD-EFGH. */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

const newUserCode = () =>
  Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/**
 * The device-code flow behind `tunnel login`. The CLI asks for a code, the person confirms it on
 * the account page (which links the machine there and then), and the CLI's poll reports the result.
 */
export function linkRoutes(app: App, accounts: Accounts) {
  const { store } = app;
  const publicUrl = app.features.publicUrl!;
  const s = {
    insert: store.prepare('INSERT INTO device_links (user_code, poll_hash, device_id, expires) VALUES (?, ?, ?, ?)'),
    poll: store.prepare<{ account_id: string | null }>(
      'SELECT account_id FROM device_links WHERE poll_hash = ? AND expires > ?',
    ),
    drop: store.prepare('DELETE FROM device_links WHERE poll_hash = ?'),
    approve: store.prepare<{ device_id: string }>(
      `UPDATE device_links SET account_id = ?
        WHERE user_code = ? AND expires > ? AND account_id IS NULL
        RETURNING device_id`,
    ),
    link: store.prepare('UPDATE devices SET account_id = ? WHERE id = ?'),
    unlink: store.prepare('UPDATE devices SET account_id = NULL WHERE id = ?'),
  };
  const limitStarts = app.counter(
    10 * 60_000,
    10,
    'Too many login requests from this machine. Wait ten minutes and try again.',
  );
  // 30^8 codes live for 10 minutes; 20 tries per account per 10 minutes makes guessing hopeless.
  const limitLinks = app.counter(10 * 60_000, 20, 'Too many link attempts. Wait ten minutes and try again.');

  app.on('POST', '/v1/auth/device', async (req, res) => {
    const device = app.device(req);
    limitStarts(req, device.id);
    const userCode = newUserCode();
    const pollToken = secretToken();
    s.insert.run(userCode, sha256(pollToken), device.id, Date.now() + LINK_S * 1000);
    send(res, 201, {
      userCode: formatCode(userCode),
      verifyUrl: `${publicUrl}/account?link=${formatCode(userCode)}`,
      pollToken,
      expiresIn: LINK_S,
      interval: app.linkPollSeconds,
    });
  });

  app.on('POST', '/v1/auth/device/poll', async (req, res) => {
    const input = await json<{ pollToken?: unknown }>(req);
    const hash = sha256(typeof input.pollToken === 'string' ? input.pollToken : '');
    const link = s.poll.get(hash, Date.now());
    if (!link) throw new HttpError(410, 'This login request expired. Run `tunnel login` again.');
    if (!link.account_id) return send(res, 202, { status: 'pending' });
    s.drop.run(hash);
    const account = accounts.byId(link.account_id);
    send(res, 200, { email: account?.email ?? null, plan: account?.plan ?? 'free' });
  });

  app.on('POST', '/v1/account/devices/link', async (req, res) => {
    accounts.requireOrigin(req);
    const account = accounts.requireSession(req);
    limitLinks(req, account.id);
    const input = await json<{ userCode?: unknown }>(req);
    const row = s.approve.get(account.id, normalizeCode(input.userCode), Date.now());
    if (!row) throw new HttpError(404, 'That code is wrong or has expired. Run `tunnel login` again for a new one.');
    s.link.run(account.id, row.device_id);
    send(res, 204);
  });

  app.on('GET', '/v1/devices/me', async (req, res) => {
    const device = app.device(req);
    const account = device.account_id ? accounts.byId(device.account_id) : undefined;
    const tunnels = app.plans.tunnelsOf(device);
    send(res, 200, {
      deviceId: device.id,
      account: account ? { email: account.email } : null,
      plan: tunnels.plan,
      limits: app.plans.limitsOf(tunnels.plan),
      usage: { tunnels: tunnels.used, storageBytes: account ? app.plans.storedBytes(account.id) : 0 },
    });
  });

  app.on('POST', '/v1/devices/me/unlink', async (req, res) => {
    const device = app.device(req);
    const account = device.account_id ? accounts.byId(device.account_id) : undefined;
    s.unlink.run(device.id);
    send(res, 200, { email: account?.email ?? null });
  });
}
```

- [ ] **Step 5: Wire the routes into `cli/src/relay/server.ts`**

Change the accounts import to `import { accountRoutes, linkRoutes } from './accounts.js';` and add, right after `const accounts = accountRoutes(app);`:

```ts
    linkRoutes(app, accounts);
```

- [ ] **Step 6: Share the device helpers in `cli/src/commands.ts`**

Add to `IO`, after `stdin?`:

```ts
  /** Open a link in the person's browser. bin.ts only does this on a terminal. */
  openUrl?(url: string): void;
```

Export `relayFor` (`export function relayFor(ctx: Ctx): string {`) and `sleep` (`export const sleep = …`). Under `deviceToken`, add:

```ts
/**
 * Call the relay as this machine's device, registering one first if needed. A relay that forgot
 * the device (its data was reset) answers 401; then register again and retry, once.
 */
export async function withDevice<T>(ctx: Ctx, relay: string, fn: (client: RelayClient) => Promise<T>): Promise<T> {
  try {
    return await fn(new RelayClient(relay, await deviceToken(ctx, relay)));
  } catch (error) {
    if ((error as TunnelError & { status?: number }).status !== 401) throw error;
    const config = ctx.store.config();
    delete config.devices[relay];
    ctx.store.saveConfig(config);
    return fn(new RelayClient(relay, await deviceToken(ctx, relay)));
  }
}
```

In `openCmd`, replace everything from `const create = async () =>` down to the closing brace of the `catch` block with:

```ts
  const res = await withDevice(ctx, relay, (client) =>
    client.json<{ tunnelId: string; memberId: string; memberToken: string }>('POST', '/v1/tunnels', {
      profile: sealText(key, JSON.stringify({ name: me })),
    }),
  );
```

- [ ] **Step 7: Create `cli/src/account-commands.ts`**

```ts
import { relayFor, sleep, withDevice, type Ctx } from './commands.js';
import { TunnelError } from './errors.js';
import { RelayClient } from './relay-client.js';
import { formatBytes, title, type Limits, type PlanName } from './relay/plans.js';

// tunnel login, logout and account. Accounts are optional: a machine that never logs in is on the
// Free plan. Each relay links separately; these commands act on the current one.

interface DeviceInfo {
  deviceId: string;
  account: { email: string } | null;
  plan: PlanName;
  limits: Limits;
  usage: { tunnels: number; storageBytes: number };
}

interface LinkStart {
  userCode: string;
  verifyUrl: string;
  pollToken: string;
  expiresIn: number;
  interval: number;
}

const statusOf = (error: unknown) => (error as TunnelError & { status?: number }).status;

export const noAccounts = (relay: string) => `The relay at ${relay} doesn't have accounts.`;

/** A call made as this machine. A 404 means the relay doesn't have the feature: `missing` says so. */
export async function asDevice<T>(
  ctx: Ctx,
  relay: string,
  method: string,
  path: string,
  data: unknown,
  missing: string,
): Promise<T> {
  try {
    return await withDevice(ctx, relay, (client) => client.json<T>(method, path, data));
  } catch (error) {
    if (statusOf(error) === 404) throw new TunnelError(missing);
    throw error;
  }
}

/** What the relay knows about this machine, or undefined when the machine never registered there. */
async function deviceInfo(ctx: Ctx, relay: string): Promise<DeviceInfo | undefined> {
  if (!ctx.store.config().devices[relay]) {
    // Nothing to look up, but a relay without accounts should still say so.
    try {
      await new RelayClient(relay).json('GET', '/v1/auth/methods');
    } catch (error) {
      if (statusOf(error) === 404) throw new TunnelError(noAccounts(relay));
      throw error;
    }
    return undefined;
  }
  return asDevice<DeviceInfo>(ctx, relay, 'GET', '/v1/devices/me', undefined, noAccounts(relay));
}

export async function loginCmd(ctx: Ctx) {
  const relay = relayFor(ctx);
  const start = await asDevice<LinkStart>(ctx, relay, 'POST', '/v1/auth/device', {}, noAccounts(relay));
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ code: start.userCode, url: start.verifyUrl, expiresIn: start.expiresIn }));
  } else {
    ctx.out(`To link this machine, open ${start.verifyUrl}`);
    ctx.out(`and confirm the code ${start.userCode}.`);
    ctx.out('Waiting for you to confirm…');
  }
  ctx.openUrl?.(start.verifyUrl);

  const client = new RelayClient(relay);
  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000, ctx.signal);
    if (ctx.signal?.aborted) throw new TunnelError('Stopped before the machine was linked.', 130);
    let reply: { status?: string; email?: string | null; plan?: PlanName };
    try {
      reply = await client.json('POST', '/v1/auth/device/poll', { pollToken: start.pollToken });
    } catch (error) {
      if (statusOf(error) === 410) break;
      throw error;
    }
    if (reply.email) {
      const plan = reply.plan ?? 'free';
      if (ctx.flags.json) ctx.out(JSON.stringify({ email: reply.email, plan }));
      else ctx.out(`Linked to ${reply.email} (${title(plan)}).`);
      return;
    }
  }
  throw new TunnelError('The code expired before it was confirmed. Run `tunnel login` again.');
}

export async function logoutCmd(ctx: Ctx) {
  const relay = relayFor(ctx);
  let email: string | null = null;
  if (ctx.store.config().devices[relay]) {
    ({ email } = await asDevice<{ email: string | null }>(
      ctx,
      relay,
      'POST',
      '/v1/devices/me/unlink',
      {},
      noAccounts(relay),
    ));
  }
  if (ctx.flags.json) return ctx.out(JSON.stringify({ email }));
  ctx.out(
    email
      ? `Unlinked this machine from ${email}. Its tunnels stay open on the Free plan's limits.`
      : "This machine isn't linked to an account.",
  );
}

export async function accountCmd(ctx: Ctx) {
  const relay = relayFor(ctx);
  const info = await deviceInfo(ctx, relay);
  if (ctx.flags.json) return ctx.out(JSON.stringify(info ?? { account: null }));
  if (!info) return ctx.out('Not signed in. Run `tunnel login`.');
  const { limits, usage } = info;
  ctx.out(
    info.account
      ? `${info.account.email}  ${title(info.plan)} plan`
      : 'Not signed in (Free plan). Run `tunnel login` to link this machine to an account.',
  );
  ctx.out(
    'Tunnels  ' +
      (limits.tunnels === 0
        ? `${usage.tunnels} open (no limit)`
        : `${usage.tunnels} of ${limits.tunnels} on this ${limits.perDevice ? 'machine' : 'account'}`),
  );
  ctx.out(
    `Files    up to ${formatBytes(limits.fileBytes)} each` +
      (limits.storageBytes ? `, ${formatBytes(usage.storageBytes)} of ${formatBytes(limits.storageBytes)} stored` : ''),
  );
  ctx.out(`History  ${limits.historyDays} days`);
}
```

- [ ] **Step 8: Add the commands to `cli/src/cli.ts`**

Add `import * as accountCommands from './account-commands.js';` under the `commands` import. In `HELP`, insert this section between `Manage` and `Setup` (the descriptions start in column 39, like the rest):

```
Account
  tunnel login                        Link this machine to your account (opens a browser)
  tunnel logout                       Unlink this machine from its account
  tunnel account                      Show your plan, limits and usage

```

In `COMMANDS`, add after `close`:

```ts
  login: accountCommands.loginCmd,
  logout: accountCommands.logoutCmd,
  account: accountCommands.accountCmd,
```

- [ ] **Step 9: Open links from `cli/src/bin.ts`**

Add `import { spawn } from 'node:child_process';` at the top, this function above `try {`:

```ts
/** Open a link in the browser when a person is at the terminal. Agents read the printed link instead. */
function openUrl(url: string) {
  if (!process.stdout.isTTY || !/^https?:\/\//.test(url)) return;
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // no browser here; the link is printed anyway
    child.unref();
  } catch {
    // same: the printed link is enough
  }
}
```

and pass it to `run`, after `stdin: readStdin,`:

```ts
    openUrl,
```

- [ ] **Step 10: Run the tests and the type check**

Run: `cd cli && node --import tsx --test test/link.test.ts && npm test && npm run typecheck`
Expected: link tests PASS (8 tests); full suite `# fail 0` (the 19 originals still pass with `openCmd` on `withDevice`); no type errors.

- [ ] **Step 11: Commit**

```bash
git add cli/src/relay/accounts.ts cli/src/relay/server.ts cli/src/commands.ts cli/src/account-commands.ts cli/src/cli.ts cli/src/bin.ts cli/test/helpers.ts cli/test/link.test.ts
git commit -m "feat: link machines to accounts with tunnel login, logout and account" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Billing through Lemon Squeezy, and `tunnel upgrade`

**Files:**
- Create: `cli/src/relay/billing/index.ts`
- Create: `cli/src/relay/billing/lemonsqueezy.ts`
- Modify: `cli/src/relay/accounts.ts` (`subscription` in `GET /v1/account`)
- Modify: `cli/src/relay/server.ts` (`App.billing`, recompute sweep, wiring)
- Modify: `cli/src/account-commands.ts` (`upgradeCmd`)
- Modify: `cli/src/cli.ts` (command and help line)
- Modify: `cli/skills/tunnel/SKILL.md` (plan-limit rule)
- Modify: `cli/test/helpers.ts` (`accountIdOf`)
- Test: `cli/test/billing.test.ts`

**Interfaces:**
- Consumes: `Accounts.requireOrigin/requireSession/byId` (Task 5), `asDevice`, `noAccounts` (Task 7), `RANK`, `PLANS`, `PRICES`, `planNamed`, `title`, `formatBytes`, `PlanName` (Task 3), `app.stats.count('checkouts')` (Task 4), `linkMachine` (Task 7).
- Produces:
  - `billing/index.ts`:
    - `type PaidPlan = 'plus' | 'pro'`
    - `interface BillingEvent { type; accountId; provider; subscriptionId; plan: PaidPlan | null; status; active: boolean; renewsAt: number | null; endsAt: number | null; updatedAt: number }`
    - `interface BillingProvider { name; checkoutUrl(account, plan): Promise<string>; portalUrl(subscriptionId): Promise<string>; verify(raw: Buffer, headers): boolean; parse(raw: Buffer): BillingEvent | undefined }`
    - `interface SubscriptionView { plan: PaidPlan; status: string; renewsAt: number | null; endsAt: number | null }`
    - `interface Billing { subscriptionOf(accountId): SubscriptionView | null }`
    - `interface Recompute { account(accountId): void; due(): void }`
    - `createRecompute(store): Recompute`
    - `billingRoutes(app, accounts, provider, recompute): Billing`. Routes: `POST /v1/account/checkout`, `POST /v1/devices/me/checkout`, `GET /v1/account/portal`, `POST /v1/billing/webhook`.
  - `billing/lemonsqueezy.ts`: `lemonSqueezy(config: NonNullable<Features['billing']>, publicUrl: string, fetcher: typeof fetch): BillingProvider`.
  - `App.billing?: Billing`.
  - `account-commands.ts`: `upgradeCmd(ctx, args)`.
  - `test/helpers.ts`: `accountIdOf(dataDir, email): Promise<string>`.

- [ ] **Step 1: Add `accountIdOf` to `cli/test/helpers.ts`**

```ts
export async function accountIdOf(dataDir: string, email: string): Promise<string> {
  const [row] = await sql(dataDir, 'SELECT id FROM accounts WHERE email = ?', email);
  if (!row) throw new Error(`No account for ${email}.`);
  return row.id;
}
```

- [ ] **Step 2: Write the failing test, `cli/test/billing.test.ts`**

```ts
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  DAY,
  FULL_ENV,
  PUBLIC_URL,
  accountIdOf,
  agent,
  browser,
  linkMachine,
  outbound,
  relay,
  signIn,
  sql,
  type Browser,
  type TestRelay,
} from './helpers.js';

const CHECKOUTS = 'https://api.lemonsqueezy.com/v1/checkouts';
const SUBSCRIPTIONS = 'https://api.lemonsqueezy.com/v1/subscriptions/';

// Lemon Squeezy's clock: each event built here is one minute newer than the one before.
let clock = Date.parse('2026-10-01T00:00:00Z');
const tick = () => new Date((clock += 60_000)).toISOString();

/** A subscription webhook body as Lemon Squeezy sends it. Variant 101 is Plus and 102 Pro in FULL_ENV. */
function lemon(event: string, accountId: string, attributes: Record<string, unknown> = {}, id = 'sub_1') {
  return JSON.stringify({
    meta: { event_name: event, custom_data: { account_id: accountId } },
    data: {
      type: 'subscriptions',
      id,
      attributes: {
        variant_id: 102,
        status: 'active',
        renews_at: '2026-11-09T00:00:00.000000Z',
        ends_at: null,
        updated_at: tick(),
        ...attributes,
      },
    },
  });
}

describe('billing', () => {
  const lines: string[] = [];
  const out = outbound({
    [CHECKOUTS]: () => Response.json({ data: { attributes: { url: 'https://pay.example/checkout/abc' } } }),
    [SUBSCRIPTIONS]: (url) =>
      Response.json({
        data: { attributes: { urls: { customer_portal: `https://pay.example/portal/${url.split('/').pop()}` } } },
      }),
  });
  let r: TestRelay;
  before(async () => {
    r = await relay({
      env: FULL_ENV,
      fetch: out.fetch,
      log: (line) => lines.push(line),
      linkPollSeconds: 0.05,
      maxTunnelsPerDevice: 1,
    });
  });
  after(() => r.close());

  const deliver = (raw: string, secret = 'whsec') =>
    fetch(`${r.url}/v1/billing/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      },
      body: raw,
    });

  /** A signed-in browser and its account id. */
  async function customer(email: string): Promise<[Browser, string]> {
    const b = browser(r);
    await signIn(b, out, email);
    return [b, await accountIdOf(r.dataDir, email)];
  }

  const planOf = async (b: Browser) => (await b.get('/v1/account')).body.plan;
  const logged = (line: string) => assert.ok(lines.includes(line), `missing "${line}" in:\n${lines.join('\n')}`);

  test('checkout opens a Lemon Squeezy page for the signed-in account', async () => {
    const [b, id] = await customer('buyer@example.com');
    const res = await b.post('/v1/account/checkout', { plan: 'pro' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { url: 'https://pay.example/checkout/abc' });
    const call = out.calls.filter((c) => c.url === CHECKOUTS).at(-1)!;
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer ls_test');
    const { attributes, relationships } = call.body.data;
    assert.deepEqual(attributes.checkout_data, { email: 'buyer@example.com', custom: { account_id: id } });
    assert.equal(attributes.product_options.redirect_url, `${PUBLIC_URL}/account?upgraded=1`);
    assert.equal(relationships.store.data.id, '11');
    assert.equal(relationships.variant.data.id, '102');

    const bad = await b.post('/v1/account/checkout', { plan: 'gold' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Pick a plan: plus or pro.');
  });

  test('a signed webhook moves the account to Pro and raises its limits', async () => {
    const [b, id] = await customer('paid@example.com');
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_paid'))).status, 200);
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'pro');
    assert.equal(me.planSource, 'billing');
    assert.equal(me.limits.fileBytes, 100 * 1024 * 1024);
    assert.deepEqual(me.subscription, {
      plan: 'pro',
      status: 'active',
      renewsAt: Date.parse('2026-11-09T00:00:00Z'),
      endsAt: null,
    });
    logged(`Billing subscription_created (active) for ${id}: applied.`);
  });

  test('a bad signature is refused and changes nothing', async () => {
    const [b, id] = await customer('forged@example.com');
    const res = await deliver(lemon('subscription_created', id, {}, 'sub_forged'), 'not-the-secret');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Bad signature.' });
    assert.equal(await planOf(b), 'free');
  });

  test('a repeated delivery is applied once', async () => {
    const [, id] = await customer('twice@example.com');
    const raw = lemon('subscription_created', id, {}, 'sub_twice');
    const count = async () => (await sql(r.dataDir, 'SELECT COUNT(*) AS n FROM billing_events'))[0].n;
    const before = await count();
    assert.equal((await deliver(raw)).status, 200);
    assert.equal((await deliver(raw)).status, 200);
    assert.equal(await count(), before + 1);
    logged(`Billing subscription_created (active) for ${id}: duplicate, skipped.`);
  });

  test('an older event arriving late does not undo a newer one', async () => {
    const [b, id] = await customer('late@example.com');
    const older = lemon('subscription_expired', id, { status: 'expired', ends_at: '2026-10-01T00:00:00.000000Z' }, 'sub_late');
    const newer = lemon('subscription_resumed', id, { status: 'active' }, 'sub_late');
    assert.equal((await deliver(newer)).status, 200);
    assert.equal((await deliver(older)).status, 200);
    assert.equal(await planOf(b), 'pro');
    logged(`Billing subscription_expired (expired) for ${id}: older than what we have, skipped.`);
  });

  test('a cancelled plan lasts until its end date, then the sweep returns it to Free', async () => {
    const [b, id] = await customer('leaving@example.com');
    const endsAt = new Date(Date.now() + 3 * DAY).toISOString();
    const cancelled = lemon('subscription_cancelled', id, { status: 'cancelled', ends_at: endsAt }, 'sub_leaving');
    assert.equal((await deliver(cancelled)).status, 200);
    assert.equal(await planOf(b), 'pro');

    await sql(r.dataDir, "UPDATE subscriptions SET ends_at = ? WHERE provider_id = 'sub_leaving'", Date.now() - 1000);
    await r.sweep();
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'free');
    assert.equal(me.planSource, null);
    assert.equal(me.subscription, null);
  });

  test('a Plus or Pro customer cannot open a second subscription', async () => {
    const [b, id] = await customer('plus@example.com');
    assert.equal((await deliver(lemon('subscription_created', id, { variant_id: 101 }, 'sub_plus'))).status, 200);
    assert.equal(await planOf(b), 'plus');

    const checkouts = () => out.calls.filter((c) => c.url === CHECKOUTS).length;
    const before = checkouts();
    const again = await b.post('/v1/account/checkout', { plan: 'pro' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'You already have a subscription. Change plans from Manage billing on your account page.');
    assert.equal(checkouts(), before);

    const a = agent(() => r, 'plus-cli');
    assert.equal((await linkMachine(a, b)).code, 0);
    const cli = await a.run('upgrade', 'pro');
    assert.equal(cli.code, 1);
    assert.match(cli.err, /^You already have a subscription\./);
    assert.equal(checkouts(), before);
  });

  test('Manage billing fetches a fresh portal link for the newest subscription', async () => {
    const [b, id] = await customer('portal@example.com');
    const none = await b.get('/v1/account/portal');
    assert.equal(none.status, 404);
    assert.equal(none.body.error, 'No subscription yet.');
    assert.equal((await deliver(lemon('subscription_created', id, {}, 'sub_portal'))).status, 200);
    assert.deepEqual((await b.get('/v1/account/portal')).body, { url: 'https://pay.example/portal/sub_portal' });
  });

  test('other products, unknown accounts and other events are ignored', async () => {
    const [b, id] = await customer('other@example.com');
    assert.equal((await deliver(lemon('subscription_created', id, { variant_id: 999 }, 'sub_other'))).status, 200);
    assert.equal((await deliver(lemon('subscription_created', 'a_nobody', {}, 'sub_ghost'))).status, 200);
    assert.equal((await deliver(JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } }))).status, 200);
    assert.equal(await planOf(b), 'free');
    logged(`Billing subscription_created (active) for ${id}: not a tunnel plan, skipped.`);
    logged('Billing subscription_created (active) for a_nobody: unknown account, skipped.');
  });

  test('an admin grant wins over billing until it ends', async () => {
    const [b, id] = await customer('granted@example.com');
    await sql(
      r.dataDir,
      "UPDATE accounts SET plan = 'pro', plan_source = 'admin', plan_until = ? WHERE id = ?",
      Date.now() + DAY,
      id,
    );
    assert.equal((await deliver(lemon('subscription_created', id, { variant_id: 101 }, 'sub_granted'))).status, 200);
    assert.equal(await planOf(b), 'pro');

    await sql(r.dataDir, 'UPDATE accounts SET plan_until = ? WHERE id = ?', Date.now() - 1000, id);
    await r.sweep();
    const me = (await b.get('/v1/account')).body;
    assert.equal(me.plan, 'plus');
    assert.equal(me.planSource, 'billing');
  });

  test('tunnel upgrade prints both prices, or opens checkout for a linked machine', async () => {
    const a = agent(() => r, 'upgrade');
    assert.equal(
      (await a.run('upgrade')).out,
      'Plus  $5/month  10 tunnels, files up to 50 MB, 30 days of history, 2 GB of storage\n' +
        'Pro   $9/month  20 tunnels, files up to 100 MB, 30 days of history, 5 GB of storage\n' +
        'Run `tunnel upgrade plus` or `tunnel upgrade pro` to pay.\n',
    );
    assert.equal((await a.run('upgrade', 'gold')).code, 2);
    const unlinked = await a.run('upgrade', 'plus');
    assert.equal(unlinked.code, 1);
    assert.equal(unlinked.err, "This machine isn't linked to an account. Run `tunnel login` first.\n");

    const [b] = await customer('cli@example.com');
    assert.equal((await linkMachine(a, b)).code, 0);
    const paid = await a.run('upgrade', 'plus');
    assert.equal(paid.code, 0, paid.err);
    assert.equal(paid.out, 'Open this page to pay for Plus:\nhttps://pay.example/checkout/abc\n');
    assert.equal(a.opened.at(-1), 'https://pay.example/checkout/abc');
  });

  test('when Lemon Squeezy is down, checkout says so', async () => {
    const [b] = await customer('down@example.com');
    const checkouts = out.table[CHECKOUTS];
    out.table[CHECKOUTS] = () => new Response('', { status: 500 });
    try {
      const res = await b.post('/v1/account/checkout', { plan: 'plus' });
      assert.equal(res.status, 502);
      assert.equal(res.body.error, "The payment page didn't load. Try again in a minute.");
    } finally {
      out.table[CHECKOUTS] = checkouts;
    }
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/billing.test.ts`
Expected: FAIL. The checkout test gets 404 instead of 200 (`POST /v1/account/checkout` doesn't exist yet).

- [ ] **Step 4: Create `cli/src/relay/billing/index.ts`**

```ts
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Accounts } from '../accounts.js';
import type { Account, Store } from '../db.js';
import { HttpError, body, json, send } from '../http.js';
import { RANK, planNamed, type PlanName } from '../plans.js';
import type { App } from '../server.js';

// Subscriptions, whoever sells them. The provider adapter turns its webhooks into BillingEvents;
// everything else (checkout guard, dedupe, ordering, the account's plan) lives here.

export type PaidPlan = 'plus' | 'pro';

export interface BillingEvent {
  /** The provider's event name, for the log. */
  type: string;
  accountId: string;
  provider: string;
  subscriptionId: string;
  /** null when the product isn't one of our plans. */
  plan: PaidPlan | null;
  /** The provider's status, verbatim. */
  status: string;
  /** Whether the customer has the plan now (a cancelled plan still runs until endsAt). */
  active: boolean;
  renewsAt: number | null;
  endsAt: number | null;
  /** When the provider last changed the subscription. Older events never overwrite newer ones. */
  updatedAt: number;
}

export interface BillingProvider {
  name: string;
  checkoutUrl(account: Account, plan: PaidPlan): Promise<string>;
  /** Portal links expire, so one is fetched each time someone opens Manage billing. */
  portalUrl(subscriptionId: string): Promise<string>;
  /** Whether the webhook body was signed with our secret. */
  verify(raw: Buffer, headers: IncomingHttpHeaders): boolean;
  /** Our view of a webhook, or undefined for events we don't act on. */
  parse(raw: Buffer): BillingEvent | undefined;
}

export interface SubscriptionView {
  plan: PaidPlan;
  status: string;
  renewsAt: number | null;
  endsAt: number | null;
}

export interface Billing {
  /** The subscription giving this account its plan now, if any. */
  subscriptionOf(accountId: string): SubscriptionView | null;
}

export interface Recompute {
  /** Set the account's plan: a running admin grant wins, then the best live subscription, then Free. */
  account(accountId: string): void;
  /** Recompute every account whose admin grant or subscription has just run out. */
  due(): void;
}

const DAY = 24 * 60 * 60 * 1000;
const LIVE = 'active = 1 AND (ends_at IS NULL OR ends_at > ?)';

export function createRecompute(store: Store): Recompute {
  const s = {
    account: store.prepare<{ plan_source: string | null; plan_until: number | null }>(
      'SELECT plan_source, plan_until FROM accounts WHERE id = ?',
    ),
    live: store.prepare<{ plan: PaidPlan }>(`SELECT plan FROM subscriptions WHERE account_id = ? AND ${LIVE}`),
    set: store.prepare('UPDATE accounts SET plan = ?, plan_source = ?, plan_until = NULL WHERE id = ?'),
    endedGrants: store.prepare<{ id: string }>(
      "SELECT id FROM accounts WHERE plan_source = 'admin' AND plan_until IS NOT NULL AND plan_until <= ?",
    ),
    endedSubscriptions: store.prepare<{ account_id: string }>(
      'UPDATE subscriptions SET active = 0 WHERE active = 1 AND ends_at IS NOT NULL AND ends_at <= ? RETURNING account_id',
    ),
  };

  const recompute: Recompute = {
    account(accountId) {
      const now = Date.now();
      const row = s.account.get(accountId);
      if (!row) return;
      if (row.plan_source === 'admin' && (row.plan_until === null || row.plan_until > now)) return;
      let best: PlanName = 'free';
      for (const sub of s.live.all(accountId, now)) if (RANK[sub.plan] > RANK[best]) best = sub.plan;
      s.set.run(best, best === 'free' ? null : 'billing', accountId);
    },
    due() {
      const now = Date.now();
      const ids = new Set([
        ...s.endedGrants.all(now).map((row) => row.id),
        ...s.endedSubscriptions.all(now).map((row) => row.account_id),
      ]);
      for (const id of ids) recompute.account(id);
    },
  };
  return recompute;
}

export function billingRoutes(app: App, accounts: Accounts, provider: BillingProvider, recompute: Recompute): Billing {
  const { store } = app;
  const s = {
    live: store.prepare<{ plan: PaidPlan; status: string; renews_at: number | null; ends_at: number | null }>(
      `SELECT plan, status, renews_at, ends_at FROM subscriptions
        WHERE account_id = ? AND ${LIVE} ORDER BY updated DESC LIMIT 1`,
    ),
    newest: store.prepare<{ provider_id: string }>(
      'SELECT provider_id FROM subscriptions WHERE account_id = ? AND provider = ? ORDER BY updated DESC LIMIT 1',
    ),
    seen: store.prepare('INSERT OR IGNORE INTO billing_events (id, received) VALUES (?, ?)'),
    hasAccount: store.prepare<{ id: string }>('SELECT id FROM accounts WHERE id = ?'),
    // The WHERE makes an event older than the stored row a no-op (changes = 0).
    upsert: store.prepare(
      `INSERT INTO subscriptions (provider, provider_id, account_id, plan, status, active, renews_at, ends_at, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, provider_id) DO UPDATE SET
         account_id = excluded.account_id, plan = excluded.plan, status = excluded.status,
         active = excluded.active, renews_at = excluded.renews_at, ends_at = excluded.ends_at,
         updated = excluded.updated
       WHERE excluded.updated >= subscriptions.updated`,
    ),
    dropEvents: store.prepare('DELETE FROM billing_events WHERE received < ?'),
  };

  async function checkout(account: Account, input: { plan?: unknown }) {
    const plan = planNamed(input.plan);
    if (plan !== 'plus' && plan !== 'pro') throw new HttpError(400, 'Pick a plan: plus or pro.');
    // A second subscription would bill twice. Plan changes go through the provider's portal.
    if (s.live.get(account.id, Date.now())) {
      throw new HttpError(409, 'You already have a subscription. Change plans from Manage billing on your account page.');
    }
    let url: string;
    try {
      url = await provider.checkoutUrl(account, plan);
    } catch (error) {
      app.log(`Checkout failed: ${(error as Error).message}`);
      throw new HttpError(502, "The payment page didn't load. Try again in a minute.");
    }
    app.stats.count('checkouts');
    return { url };
  }

  app.on('POST', '/v1/account/checkout', async (req, res) => {
    accounts.requireOrigin(req);
    const account = accounts.requireSession(req);
    send(res, 200, await checkout(account, await json(req)));
  });

  app.on('POST', '/v1/devices/me/checkout', async (req, res) => {
    const device = app.device(req);
    const input = await json<{ plan?: unknown }>(req);
    const account = device.account_id ? accounts.byId(device.account_id) : undefined;
    if (!account) throw new HttpError(409, "This machine isn't linked to an account. Run `tunnel login` first.");
    send(res, 200, await checkout(account, input));
  });

  app.on('GET', '/v1/account/portal', async (req, res) => {
    const account = accounts.requireSession(req);
    const sub = s.newest.get(account.id, provider.name);
    if (!sub) throw new HttpError(404, 'No subscription yet.');
    let url: string;
    try {
      url = await provider.portalUrl(sub.provider_id);
    } catch (error) {
      app.log(`Billing portal failed: ${(error as Error).message}`);
      throw new HttpError(502, "The billing page didn't load. Try again in a minute.");
    }
    send(res, 200, { url });
  });

  /** Store the event and update the account. Returns what happened, for the log. */
  function apply(raw: Buffer, event: BillingEvent): string {
    const id = createHash('sha256').update(raw).digest('hex');
    store.db.exec('BEGIN IMMEDIATE');
    try {
      let outcome: string;
      if (Number(s.seen.run(id, Date.now()).changes) === 0) outcome = 'duplicate, skipped';
      else if (!event.plan) outcome = 'not a tunnel plan, skipped';
      else if (!s.hasAccount.get(event.accountId)) outcome = 'unknown account, skipped';
      else {
        const changes = s.upsert.run(
          provider.name,
          event.subscriptionId,
          event.accountId,
          event.plan,
          event.status,
          event.active ? 1 : 0,
          event.renewsAt,
          event.endsAt,
          event.updatedAt,
        ).changes;
        if (Number(changes) === 0) outcome = 'older than what we have, skipped';
        else {
          recompute.account(event.accountId);
          outcome = 'applied';
        }
      }
      store.db.exec('COMMIT');
      return outcome;
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  }

  // 400 makes the provider retry; everything else gets 200 so it stops. Bodies are never logged.
  app.on('POST', '/v1/billing/webhook', async (req, res) => {
    const raw = await body(req, 1024 * 1024);
    if (!provider.verify(raw, req.headers)) throw new HttpError(400, 'Bad signature.');
    const event = provider.parse(raw);
    if (event) {
      const outcome = apply(raw, event);
      app.log(`Billing ${event.type} (${event.status}) for ${event.accountId || 'no account'}: ${outcome}.`);
    }
    send(res, 200, { ok: true });
  });

  app.sweeps.push(() => {
    s.dropEvents.run(Date.now() - 90 * DAY);
  });

  return {
    subscriptionOf(accountId) {
      const row = s.live.get(accountId, Date.now());
      return row ? { plan: row.plan, status: row.status, renewsAt: row.renews_at, endsAt: row.ends_at } : null;
    },
  };
}
```

- [ ] **Step 5: Create `cli/src/relay/billing/lemonsqueezy.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Features } from '../config.js';
import type { BillingProvider, PaidPlan } from './index.js';

// Lemon Squeezy, the merchant of record: it sells the subscription, charges tax and sends invoices.
// Its API is JSON:API. Webhooks are signed with an HMAC of the raw body in X-Signature.

const API = 'https://api.lemonsqueezy.com/v1';

const EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
]);

/** Statuses where the customer has what they paid for. "cancelled" also counts until ends_at. */
const ACTIVE = new Set(['on_trial', 'active', 'past_due']);

export function lemonSqueezy(
  config: NonNullable<Features['billing']>,
  publicUrl: string,
  fetcher: typeof fetch,
): BillingProvider {
  const planOf = (variantId: unknown): PaidPlan | null => {
    const id = String(variantId);
    if (id === config.variants.plus) return 'plus';
    if (id === config.variants.pro) return 'pro';
    return null;
  };

  const time = (value: unknown) => (typeof value === 'string' && value ? Date.parse(value) || null : null);

  async function call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const res = await fetcher(API + path, {
      method,
      headers: {
        accept: 'application/vnd.api+json',
        'content-type': 'application/vnd.api+json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Lemon Squeezy answered ${res.status} to ${method} ${path.split('/')[1]}`);
    return (await res.json()) as T;
  }

  return {
    name: 'lemonsqueezy',

    async checkoutUrl(account, plan) {
      const reply = await call<{ data: { attributes: { url: string } } }>('POST', '/checkouts', {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: { email: account.email, custom: { account_id: account.id } },
            product_options: { redirect_url: `${publicUrl}/account?upgraded=1` },
          },
          relationships: {
            store: { data: { type: 'stores', id: config.storeId } },
            variant: { data: { type: 'variants', id: config.variants[plan] } },
          },
        },
      });
      return reply.data.attributes.url;
    },

    async portalUrl(subscriptionId) {
      const reply = await call<{ data: { attributes: { urls: { customer_portal: string } } } }>(
        'GET',
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      return reply.data.attributes.urls.customer_portal;
    },

    verify(raw, headers) {
      const given = Buffer.from(String(headers['x-signature'] ?? ''), 'utf8');
      const expected = Buffer.from(createHmac('sha256', config.webhookSecret).update(raw).digest('hex'), 'utf8');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    parse(raw) {
      let payload: any;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return undefined;
      }
      const type = payload?.meta?.event_name;
      if (!EVENTS.has(type) || !payload.data?.id) return undefined;
      const attributes = payload.data.attributes ?? {};
      const status = String(attributes.status ?? '');
      const endsAt = time(attributes.ends_at);
      return {
        type,
        accountId: String(payload.meta.custom_data?.account_id ?? ''),
        provider: 'lemonsqueezy',
        subscriptionId: String(payload.data.id),
        plan: planOf(attributes.variant_id),
        status,
        active: ACTIVE.has(status) || (status === 'cancelled' && endsAt !== null),
        renewsAt: time(attributes.renews_at),
        endsAt,
        updatedAt: time(attributes.updated_at) ?? Date.now(),
      };
    },
  };
}
```

- [ ] **Step 6: Show the subscription on the account page, in `cli/src/relay/accounts.ts`**

In the `GET /v1/account` handler, replace `subscription: null,` with:

```ts
      subscription: app.billing?.subscriptionOf(account.id) ?? null,
```

- [ ] **Step 7: Wire billing into `cli/src/relay/server.ts`**

Add the imports:

```ts
import { billingRoutes, createRecompute, type Billing } from './billing/index.js';
import { lemonSqueezy } from './billing/lemonsqueezy.js';
```

In `App`, add:

```ts
  /** Set when billing is configured. */
  billing?: Billing;
```

Replace the `if (features.publicUrl) { … }` block with:

```ts
  if (features.publicUrl) {
    const accounts = accountRoutes(app);
    linkRoutes(app, accounts);
    // Admin grants end even on a relay without billing, so the recompute sweep always runs.
    const recompute = createRecompute(store);
    app.sweeps.push(() => recompute.due());
    if (features.email) emailRoutes(app, accounts, features.email);
    if (features.github) githubRoutes(app, accounts, features.github);
    if (features.billing) {
      const provider = lemonSqueezy(features.billing, features.publicUrl, app.fetch);
      app.billing = billingRoutes(app, accounts, provider, recompute);
    }
  }
```

- [ ] **Step 8: Add `upgradeCmd` to `cli/src/account-commands.ts`**

Change the errors import to `import { TunnelError, UsageError } from './errors.js';` and the plans import to:

```ts
import { formatBytes, PLANS, planNamed, PRICES, title, type Limits, type PlanName } from './relay/plans.js';
```

Append:

```ts
export async function upgradeCmd(ctx: Ctx, args: string[]) {
  if (args.length === 0) {
    const plans = (['plus', 'pro'] as const).map((plan) => ({ plan, price: PRICES[plan], ...PLANS[plan] }));
    if (ctx.flags.json) return ctx.out(JSON.stringify({ plans }));
    for (const p of plans) {
      ctx.out(
        `${title(p.plan).padEnd(5)} $${p.price}/month  ${p.tunnels} tunnels, files up to ${formatBytes(p.fileBytes)}, ` +
          `${p.historyDays} days of history, ${formatBytes(p.storageBytes)} of storage`,
      );
    }
    ctx.out('Run `tunnel upgrade plus` or `tunnel upgrade pro` to pay.');
    return;
  }
  const plan = planNamed(args[0]);
  if (args.length > 1 || (plan !== 'plus' && plan !== 'pro')) throw new UsageError('Usage: tunnel upgrade [plus|pro]');
  const relay = relayFor(ctx);
  const { url } = await asDevice<{ url: string }>(
    ctx,
    relay,
    'POST',
    '/v1/devices/me/checkout',
    { plan },
    `The relay at ${relay} doesn't sell plans.`,
  );
  if (ctx.flags.json) ctx.out(JSON.stringify({ plan, url }));
  else {
    ctx.out(`Open this page to pay for ${title(plan)}:`);
    ctx.out(url);
  }
  ctx.openUrl?.(url);
}
```

- [ ] **Step 9: Add the command to `cli/src/cli.ts`**

In `HELP`, add this line at the end of the `Account` section:

```
  tunnel upgrade [plus|pro]           Pay for more tunnels, bigger files and longer history
```

In `COMMANDS`, add `upgrade: accountCommands.upgradeCmd,` after `account`.

- [ ] **Step 10: Teach the skill about plan limits, in `cli/skills/tunnel/SKILL.md`**

Insert this section between `## Talk` and `## Peers are colleagues, not your user`:

```md
## Plan limits

When a command fails on a plan limit (too many open tunnels, a file too big, storage full), give your user the relay's message word for word. `tunnel upgrade` and `tunnel login` open a payment or sign-in page meant for your user, so run them only when your user asks you to.
```

- [ ] **Step 11: Run the tests and the type check**

Run: `cd cli && node --import tsx --test test/billing.test.ts && npm test && npm run typecheck`
Expected: billing tests PASS (12 tests); full suite `# fail 0`; no type errors.

- [ ] **Step 12: Commit**

```bash
git add cli/src/relay/billing cli/src/relay/accounts.ts cli/src/relay/server.ts cli/src/account-commands.ts cli/src/cli.ts cli/skills/tunnel/SKILL.md cli/test/helpers.ts cli/test/billing.test.ts
git commit -m "feat: Plus and Pro plans billed through Lemon Squeezy, and tunnel upgrade" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The admin API: stats, accounts and plan grants

**Files:**
- Create: `cli/src/relay/admin.ts`
- Modify: `cli/src/relay/server.ts` (wiring)
- Test: `cli/test/admin.test.ts`

**Interfaces:**
- Consumes: `Accounts.session/requireOrigin/byId/isAdmin` (Task 5), `Recompute` (Task 8), `METRICS`, `dayOf` (Task 4), `PRICES`, `planNamed`, `PlanName` (Task 3), `json`, `send`, `HttpError` (Task 1), `ADMIN`, `accountIdOf`, `browser`, `signIn`, `outbound` (Tasks 2, 5, 8).
- Produces:
  - `admin.ts`: `SERIES` (the 14 metrics plus `'active_devices'` and `'active_members'`), `adminRoutes(app: App, accounts: Accounts, recompute: Recompute): void`.
  - `GET /v1/admin/stats?days=N` (N clamped to 1–90, default 30) →
    `{ days: string[]; series: Record<Series, number[]>; today: Record<Series, number>; active: { agents, devices, accounts: { d1, d7, d30 } }; plans: { free, plus, pro }; mrr: number; referrers: { host, n }[] }`.
    `days` runs oldest first and ends today (UTC); every series has one number per day, zero-filled.
  - `GET /v1/admin/accounts?q=&cursor=` → `{ accounts: AdminAccount[]; next: string | null }`, 50 per page, newest first. `AdminAccount = { id, email, githubLogin, plan, planSource, planUntil, created, seen, devices, tunnels }`.
  - `POST /v1/admin/accounts/:id/plan { plan: 'free' | 'plus' | 'pro' | null, until?: number | null }` → `{ plan, planSource, planUntil }`. `null` clears the grant and lets billing decide again.
  - Every admin route answers 404 `Not found.` (the router's own 404) to anyone who isn't an admin.

- [ ] **Step 1: Write the failing test, `cli/test/admin.test.ts`**

```ts
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf } from '../src/relay/stats.js';
import {
  ADMIN,
  DAY,
  FULL_ENV,
  accountIdOf,
  agent,
  browser,
  outbound,
  relay,
  signIn,
  sql,
  type Browser,
  type TestRelay,
} from './helpers.js';

describe('admin', () => {
  const out = outbound();
  let r: TestRelay;
  let boss: Browser;
  before(async () => {
    r = await relay({ env: FULL_ENV, fetch: out.fetch, maxTunnelsPerDevice: 1 });
    boss = browser(r);
    await signIn(boss, out, ADMIN);
  });
  after(() => r.close());

  const grant = (b: Browser, id: string, data: unknown) => b.post(`/v1/admin/accounts/${id}/plan`, data);

  test('admin routes look like they do not exist to everyone else', async () => {
    const anonymous = browser(r);
    const user = browser(r);
    await signIn(user, out, 'outsider@example.com');
    const id = await accountIdOf(r.dataDir, 'outsider@example.com');
    for (const b of [anonymous, user]) {
      for (const res of [
        await b.get('/v1/admin/stats'),
        await b.get('/v1/admin/accounts'),
        await grant(b, id, { plan: 'pro' }),
      ]) {
        assert.equal(res.status, 404);
        assert.deepEqual(res.body, { error: 'Not found.' });
      }
    }
    assert.equal((await user.get('/v1/account')).body.plan, 'free');
  });

  test('stats: daily series, active agents and machines, plans, revenue and referrers', async () => {
    const a = agent(() => r, 'stats');
    assert.equal((await a.run('open', 'c')).code, 0);
    assert.equal((await a.run('send', 'hello')).code, 0);
    await sql(
      r.dataDir,
      "INSERT INTO stats_daily (day, metric, n) VALUES (?, 'messages', 7)",
      dayOf(Date.now() - 2 * DAY),
    );
    await sql(r.dataDir, "INSERT INTO referrers (day, host, n) VALUES (?, 'news.ycombinator.com', 3)", dayOf());
    const now = Date.now();
    await sql(
      r.dataDir,
      `INSERT INTO accounts (id, email, plan, plan_source, created, seen) VALUES
         ('a_payer', 'payer@example.com', 'plus', 'billing', ?1, ?1),
         ('a_gift', 'gift@example.com', 'pro', 'admin', ?1, ?1)`,
      now,
    );

    const res = await boss.get('/v1/admin/stats');
    assert.equal(res.status, 200);
    const stats = res.body;
    assert.equal(stats.days.length, 30);
    assert.equal(stats.days.at(-1), dayOf());
    assert.equal(stats.series.messages.length, 30);
    assert.equal(stats.series.messages.at(-3), 7);
    assert.equal(stats.series.messages.at(-1), 1);
    assert.equal(stats.series.messages.at(-2), 0);
    assert.equal(stats.today.messages, 1);
    assert.equal(stats.today.tunnels_opened, 1);
    assert.equal(stats.series.active_devices.at(-1), 1);
    assert.equal(stats.series.active_members.at(-1), 1);
    assert.deepEqual(stats.active.devices, { d1: 1, d7: 1, d30: 1 });
    assert.deepEqual(stats.active.agents, { d1: 1, d7: 1, d30: 1 });
    assert.ok(stats.active.accounts.d1 >= 1, 'the signed-in admin is active');
    assert.equal(stats.plans.plus, 1);
    assert.equal(stats.plans.pro, 1);
    assert.equal(stats.mrr, 5); // the gift is not revenue
    assert.deepEqual(stats.referrers, [{ host: 'news.ycombinator.com', n: 3 }]);

    assert.equal((await boss.get('/v1/admin/stats?days=500')).body.days.length, 90);
    assert.equal((await boss.get('/v1/admin/stats?days=nonsense')).body.days.length, 30);
  });

  test('accounts: search, newest first, 50 to a page', async () => {
    await sql(
      r.dataDir,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 55)
       INSERT INTO accounts (id, email, created, seen) SELECT 'a_bulk' || i, 'bulk' || i || '@example.com', i, i FROM n`,
    );
    const first = (await boss.get('/v1/admin/accounts?q=bulk')).body;
    assert.equal(first.accounts.length, 50);
    assert.equal(first.next, '50');
    assert.equal(first.accounts[0].email, 'bulk55@example.com');
    assert.deepEqual(Object.keys(first.accounts[0]).sort(), [
      'created',
      'devices',
      'email',
      'githubLogin',
      'id',
      'plan',
      'planSource',
      'planUntil',
      'seen',
      'tunnels',
    ]);
    const second = (await boss.get(`/v1/admin/accounts?q=bulk&cursor=${first.next}`)).body;
    assert.equal(second.accounts.length, 5);
    assert.equal(second.next, null);
    assert.equal(second.accounts.at(-1).email, 'bulk1@example.com');

    assert.equal((await boss.get('/v1/admin/accounts?q=BULK1')).body.accounts.length, 11); // bulk1, bulk10–19
    assert.equal((await boss.get('/v1/admin/accounts?q=%25')).body.accounts.length, 0); // "%" is literal
    assert.ok((await boss.get('/v1/admin/accounts')).body.accounts.length > 0);
  });

  test('grants: give a plan with an end date, clear it, and refuse bad input', async () => {
    const user = browser(r);
    await signIn(user, out, 'friend@example.com');
    const id = await accountIdOf(r.dataDir, 'friend@example.com');
    const until = Date.now() + 7 * DAY;

    const given = await grant(boss, id, { plan: 'pro', until });
    assert.equal(given.status, 200);
    assert.deepEqual(given.body, { plan: 'pro', planSource: 'admin', planUntil: until });
    assert.equal((await user.get('/v1/account')).body.limits.tunnels, 20);

    const cleared = await grant(boss, id, { plan: null });
    assert.deepEqual(cleared.body, { plan: 'free', planSource: null, planUntil: null });

    const gold = await grant(boss, id, { plan: 'gold' });
    assert.equal(gold.status, 400);
    assert.equal(gold.body.error, 'Plan must be free, plus, pro or null.');
    const past = await grant(boss, id, { plan: 'plus', until: Date.now() - 1000 });
    assert.equal(past.status, 400);
    assert.equal(past.body.error, 'The end date must be in the future.');
    const nobody = await grant(boss, 'a_nobody', { plan: 'plus' });
    assert.equal(nobody.status, 404);
    assert.equal(nobody.body.error, 'No account with that id.');
  });

  test('a grant from another site is blocked, even with the admin cookie', async () => {
    const id = await accountIdOf(r.dataDir, 'outsider@example.com');
    const evil = browser(r, 'https://evil.example');
    for (const [name, value] of boss.jar) evil.jar.set(name, value);
    const res = await grant(evil, id, { plan: 'pro' });
    assert.equal(res.status, 403);
    assert.equal((await sql(r.dataDir, 'SELECT plan FROM accounts WHERE id = ?', id))[0].plan, 'free');
  });

  test('a grant that runs out ends at the next sweep', async () => {
    const user = browser(r);
    await signIn(user, out, 'trial@example.com');
    const id = await accountIdOf(r.dataDir, 'trial@example.com');
    assert.equal((await grant(boss, id, { plan: 'plus', until: Date.now() + DAY })).status, 200);
    await sql(r.dataDir, 'UPDATE accounts SET plan_until = ? WHERE id = ?', Date.now() - 1000, id);
    await r.sweep();
    const me = (await user.get('/v1/account')).body;
    assert.equal(me.plan, 'free');
    assert.equal(me.planSource, null);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && node --import tsx --test test/admin.test.ts`
Expected: FAIL in `stats: daily series…` with `404 !== 200` (no admin routes yet). The first test passes already, since unknown routes are 404.

- [ ] **Step 3: Create `cli/src/relay/admin.ts`**

```ts
import type { IncomingMessage } from 'node:http';
import type { Accounts } from './accounts.js';
import type { Account } from './db.js';
import { HttpError, json, send } from './http.js';
import { PRICES, planNamed, type PlanName } from './plans.js';
import type { Recompute } from './billing/index.js';
import type { App } from './server.js';
import { METRICS, dayOf } from './stats.js';

// The owner's view: daily counts, who is active, what plans people are on, and plan grants.
// Admins are the emails in TUNNEL_ADMIN_EMAILS. Everyone else gets the router's own 404.

export const SERIES = [...METRICS, 'active_devices', 'active_members'] as const;
type Series = (typeof SERIES)[number];

const DAY = 24 * 60 * 60 * 1000;
const PAGE = 50;

interface AccountRow {
  id: string;
  email: string;
  github_login: string | null;
  plan: PlanName;
  plan_source: string | null;
  plan_until: number | null;
  created: number;
  seen: number;
  devices: number;
  tunnels: number;
}

export function adminRoutes(app: App, accounts: Accounts, recompute: Recompute) {
  const { store } = app;
  const s = {
    daily: store.prepare<{ day: string; metric: string; n: number }>(
      'SELECT day, metric, n FROM stats_daily WHERE day >= ?',
    ),
    activeDaily: store.prepare<{ day: string; metric: string; n: number }>(
      `SELECT day, 'active_devices' AS metric, COUNT(*) AS n FROM active_devices WHERE day >= ?1 GROUP BY day
       UNION ALL
       SELECT day, 'active_members' AS metric, COUNT(*) AS n FROM active_members WHERE day >= ?1 GROUP BY day`,
    ),
    agents: store.prepare<{ n: number }>('SELECT COUNT(DISTINCT member_id) AS n FROM active_members WHERE day >= ?'),
    devices: store.prepare<{ n: number }>('SELECT COUNT(DISTINCT device_id) AS n FROM active_devices WHERE day >= ?'),
    // Signed in on the site, or used a linked machine.
    activeAccounts: store.prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM accounts a
        WHERE a.seen >= ?1
           OR EXISTS (SELECT 1 FROM active_devices ad JOIN devices d ON d.id = ad.device_id
                       WHERE d.account_id = a.id AND ad.day >= ?2)`,
    ),
    plans: store.prepare<{ plan: PlanName; n: number }>('SELECT plan, COUNT(*) AS n FROM accounts GROUP BY plan'),
    paying: store.prepare<{ plan: PlanName; n: number }>(
      "SELECT plan, COUNT(*) AS n FROM accounts WHERE plan_source = 'billing' GROUP BY plan",
    ),
    referrers: store.prepare<{ host: string; n: number }>(
      'SELECT host, SUM(n) AS n FROM referrers WHERE day >= ? GROUP BY host ORDER BY n DESC, host LIMIT 10',
    ),
    // One extra row tells us whether there is a next page.
    accounts: store.prepare<AccountRow>(
      `SELECT a.id, a.email, a.github_login, a.plan, a.plan_source, a.plan_until, a.created, a.seen,
              (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS devices,
              (SELECT COUNT(*) FROM tunnels t JOIN devices d ON d.id = t.owner_device WHERE d.account_id = a.id) AS tunnels
         FROM accounts a
        WHERE ?1 = '' OR a.email LIKE ?2 ESCAPE '\\' OR a.github_login LIKE ?2 ESCAPE '\\'
        ORDER BY a.created DESC, a.id
        LIMIT ${PAGE + 1} OFFSET ?3`,
    ),
    grant: store.prepare("UPDATE accounts SET plan = ?, plan_source = 'admin', plan_until = ? WHERE id = ?"),
    clearGrant: store.prepare(
      "UPDATE accounts SET plan_source = NULL, plan_until = NULL WHERE id = ? AND plan_source = 'admin'",
    ),
  };

  function requireAdmin(req: IncomingMessage): Account {
    const account = accounts.session(req);
    if (!account || !accounts.isAdmin(account)) throw new HttpError(404, 'Not found.');
    return account;
  }

  /** Distinct actives over the last 1, 7 and 30 days, today included. */
  function windows(count: (since: string, sinceMs: number) => number) {
    const at = (days: number) => {
      const since = dayOf(Date.now() - (days - 1) * DAY);
      return count(since, Date.parse(`${since}T00:00:00Z`));
    };
    return { d1: at(1), d7: at(7), d30: at(30) };
  }

  app.on('GET', '/v1/admin/stats', async (req, res, _params, url) => {
    requireAdmin(req);
    const span = Math.min(90, Math.max(1, Math.floor(Number(url.searchParams.get('days') ?? 30)) || 30));
    const now = Date.now();
    const days = Array.from({ length: span }, (_, i) => dayOf(now - (span - 1 - i) * DAY));
    const index = new Map(days.map((day, i) => [day, i]));
    const series = Object.fromEntries(SERIES.map((name) => [name, days.map(() => 0)])) as Record<Series, number[]>;
    for (const row of [...s.daily.all(days[0]), ...s.activeDaily.all(days[0])]) {
      const i = index.get(row.day);
      const line = series[row.metric as Series];
      if (i !== undefined && line) line[i] = row.n;
    }
    const today = Object.fromEntries(SERIES.map((name) => [name, series[name][span - 1]])) as Record<Series, number>;

    const plans: Record<PlanName, number> = { free: 0, plus: 0, pro: 0 };
    for (const row of s.plans.all()) if (planNamed(row.plan)) plans[row.plan] = row.n;
    let mrr = 0;
    for (const row of s.paying.all()) if (row.plan === 'plus' || row.plan === 'pro') mrr += PRICES[row.plan] * row.n;

    send(res, 200, {
      days,
      series,
      today,
      active: {
        agents: windows((since) => s.agents.get(since)?.n ?? 0),
        devices: windows((since) => s.devices.get(since)?.n ?? 0),
        accounts: windows((since, sinceMs) => s.activeAccounts.get(sinceMs, since)?.n ?? 0),
      },
      plans,
      mrr,
      referrers: s.referrers.all(days[0]),
    });
  });

  app.on('GET', '/v1/admin/accounts', async (req, res, _params, url) => {
    requireAdmin(req);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('cursor') ?? 0)) || 0);
    const rows = s.accounts.all(q, pattern, offset);
    send(res, 200, {
      accounts: rows.slice(0, PAGE).map((row) => ({
        id: row.id,
        email: row.email,
        githubLogin: row.github_login,
        plan: row.plan,
        planSource: row.plan_source,
        planUntil: row.plan_until,
        created: row.created,
        seen: row.seen,
        devices: row.devices,
        tunnels: row.tunnels,
      })),
      next: rows.length > PAGE ? String(offset + PAGE) : null,
    });
  });

  app.on('POST', '/v1/admin/accounts/:id/plan', async (req, res, [id]) => {
    requireAdmin(req);
    accounts.requireOrigin(req);
    const input = await json<{ plan?: unknown; until?: unknown }>(req);
    if (!accounts.byId(id)) throw new HttpError(404, 'No account with that id.');
    if (input.plan === null) {
      // Back to whatever billing says.
      s.clearGrant.run(id);
      recompute.account(id);
    } else {
      const plan = planNamed(input.plan);
      if (!plan) throw new HttpError(400, 'Plan must be free, plus, pro or null.');
      const until = input.until ?? null;
      if (until !== null && !(typeof until === 'number' && until > Date.now())) {
        throw new HttpError(400, 'The end date must be in the future.');
      }
      s.grant.run(plan, until, id);
    }
    const account = accounts.byId(id)!;
    send(res, 200, { plan: account.plan, planSource: account.plan_source, planUntil: account.plan_until });
  });
}
```

- [ ] **Step 4: Wire it into `cli/src/relay/server.ts`**

Add `import { adminRoutes } from './admin.js';` and, inside the `if (features.publicUrl) { … }` block after the billing lines:

```ts
    if (features.adminEmails.size > 0) adminRoutes(app, accounts, recompute);
```

- [ ] **Step 5: Run the tests and the type check**

Run: `cd cli && node --import tsx --test test/admin.test.ts && npm test && npm run typecheck`
Expected: admin tests PASS (6 tests); full suite `# fail 0`; no type errors.

- [ ] **Step 6: Commit**

```bash
git add cli/src/relay/admin.ts cli/src/relay/server.ts cli/test/admin.test.ts
git commit -m "feat(relay): admin API for stats, accounts and plan grants" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Landing page, pricing, legal pages and the multi-page build

**Files:**
- Create: `site/scripts/check.mjs`
- Modify: `site/package.json` (`check` script)
- Modify: `site/vite.config.ts`
- Create: `site/src/page.ts`
- Create: `site/src/app.css`
- Create: `site/src/legal.ts`
- Create: `site/terms.html`, `site/privacy.html`, `site/refund.html`
- Modify: `site/index.html`
- Modify: `site/src/style.css`
- Modify: `site/src/main.ts`
- Modify: `site/public/robots.txt`, `site/public/llms.txt`

**Interfaces:**
- Consumes: the relay routes `POST /v1/hit` (Task 4); the `tunnel_signed_in` cookie (Task 5).
- Produces:
  - `site/src/page.ts`: `class ApiError(status: number, message: string)`, `api<T>(method, path, data?): Promise<T>`, `messageOf(error: unknown): string`, `beacon(): void`, `accountLink(): void`, `formatBytes(n: number): string`, `title(plan: string): string`, `formatDay(ms: number): string`.
  - `site/src/app.css`: styles for the pages that aren't the landing page: `[hidden]`, `.page`, `.page-title`, `.page-lede`, `.page-subtitle`, `.status` (with `data-tone="error"`), `.legal`.
  - `vite.config.ts`: `PAGES` (Tasks 11 and 12 add `'account'` and `'admin'`) and `PRIVATE = ['account', 'admin']`.
  - `scripts/check.mjs`: the same `PAGES` and `PRIVATE` lists, checked against `dist/`.

The site has no unit tests. `npm run check` inspects the built `dist/` instead, and is this task's failing test.

- [ ] **Step 1: Write the failing check, `site/scripts/check.mjs`**

```js
// Checks the built site in dist/. Run `npm run build` first. Exits 1 with a list of problems.
import { existsSync, readFileSync } from 'node:fs';

const SITE = 'https://tunnel.dilyor.dev/';
// Every page the build must produce (keep in step with vite.config.ts).
const PAGES = ['index', 'terms', 'privacy', 'refund'];
// Signed-in pages: noindex, and never in the sitemap.
const PRIVATE = ['account', 'admin'];

const dist = new URL('../dist/', import.meta.url);
const has = (file) => existsSync(new URL(file, dist));
const read = (file) => readFileSync(new URL(file, dist), 'utf8');
const problems = [];
const expect = (ok, problem) => {
  if (!ok) problems.push(problem);
};

for (const page of PAGES) expect(has(`${page}.html`), `dist/${page}.html is missing`);

if (has('index.html')) {
  const index = read('index.html');
  const blocks = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(blocks.length === 1, `index.html has ${blocks.length} JSON-LD blocks, expected 1`);
  if (blocks.length === 1) {
    const graph = JSON.parse(blocks[0][1])['@graph'];
    const app = graph.find((node) => node['@type'] === 'SoftwareApplication');
    const prices = [].concat(app?.offers ?? []).map((offer) => offer.price).join(', ');
    expect(prices === '0, 5, 9', `offers are priced [${prices}], expected [0, 5, 9]`);
    const faq = graph.find((node) => node['@type'] === 'FAQPage');
    const shown = index.match(/<details>/g)?.length ?? 0;
    expect(faq?.mainEntity.length === shown, `FAQPage has ${faq?.mainEntity.length} questions, the page shows ${shown}`);
    expect(shown === 10, `the page shows ${shown} questions, expected 10`);
  }
  expect(!/\btrial\b|pay as you go/i.test(index), 'index.html still mentions the trial or pay as you go');
  expect(index.includes('data-account-link'), 'the nav has no Sign in link');
  expect(index.includes('Install tunnel from tunnel.dilyor.dev'), 'the "tell your agent" hint is missing');
  expect(
    index.includes('href="/account?plan=plus"') && index.includes('href="/account?plan=pro"'),
    'the Get Plus and Get Pro buttons are missing',
  );
}

for (const page of PAGES.filter((p) => p !== 'index' && has(`${p}.html`))) {
  const html = read(`${page}.html`);
  expect(!html.includes('application/ld+json'), `${page}.html has JSON-LD; only the landing page should`);
  if (PRIVATE.includes(page)) expect(html.includes('<meta name="robots" content="noindex"'), `${page}.html must be noindex`);
  else expect(html.includes(`<link rel="canonical" href="${SITE}${page}"`), `${page}.html has no canonical link`);
}

if (has('sitemap.xml')) {
  const listed = [...read('sitemap.xml').matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  const wanted = PAGES.filter((p) => !PRIVATE.includes(p)).map((p) => SITE + (p === 'index' ? '' : p));
  expect(listed.join(' ') === wanted.join(' '), `sitemap lists [${listed.join(', ')}], expected [${wanted.join(', ')}]`);
} else {
  problems.push('dist/sitemap.xml is missing');
}

const robots = has('robots.txt') ? read('robots.txt').split(/\r?\n/) : [];
for (const path of ['/v1/', '/account', '/admin']) expect(robots.includes(`Disallow: ${path}`), `robots.txt doesn't disallow ${path}`);
expect(has('llms.txt') && read('llms.txt').includes('$5 a month'), 'llms.txt has no pricing');

if (problems.length) {
  console.error(`Site check failed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Site check passed: ${PAGES.length} pages.`);
```

In `site/package.json`, add to `scripts`:

```json
    "check": "node scripts/check.mjs",
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd site && npm run build && npm run check`
Expected: FAIL with `dist/terms.html is missing` (and privacy, refund), `offers are priced [0], expected [0, 5, 9]`, `the page shows 7 questions, expected 10`, `index.html still mentions the trial or pay as you go`, and the robots and llms.txt lines.

- [ ] **Step 3: Make the build multi-page, in `site/vite.config.ts`**

Replace the first line with:

```ts
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
```

Under `DESCRIPTION`, add:

```ts
/** Every HTML page in the build. */
const PAGES = ['index', 'terms', 'privacy', 'refund'];
/** Signed-in pages: noindex, and left out of the sitemap. */
const PRIVATE = ['account', 'admin'];

const OFFERS = [
  { name: 'Free', price: '0', description: '1 tunnel per machine, files up to 10 MB, 7 days of history' },
  { name: 'Plus', price: '5', description: '10 tunnels, files up to 50 MB, 30 days of history, 2 GB of storage' },
  { name: 'Pro', price: '9', description: '20 tunnels, files up to 100 MB, 30 days of history, 5 GB of storage' },
];
```

Change the hook's first lines so only the landing page gets structured data:

```ts
    transformIndexHtml(html, ctx) {
      if (basename(ctx.filename) !== 'index.html') return html;
```

Replace the `offers` line in the `SoftwareApplication` node with:

```ts
            offers: OFFERS.map((offer) => ({
              '@type': 'Offer',
              name: offer.name,
              price: offer.price,
              priceCurrency: 'USD',
              description: offer.description,
              ...(offer.price !== '0' && {
                priceSpecification: {
                  '@type': 'UnitPriceSpecification',
                  price: offer.price,
                  priceCurrency: 'USD',
                  unitCode: 'MON',
                },
              }),
            })),
```

Replace the sitemap `source` in `generateBundle` with:

```ts
        source:
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          PAGES.filter((page) => !PRIVATE.includes(page))
            .map((page) => `  <url><loc>${SITE}${page === 'index' ? '' : page}</loc><lastmod>${today}</lastmod></url>\n`)
            .join('') +
          '</urlset>\n',
```

Replace the last line with:

```ts
export default defineConfig({
  plugins: [seo()],
  build: {
    rolldownOptions: {
      input: Object.fromEntries(PAGES.map((page) => [page, fileURLToPath(new URL(`./${page}.html`, import.meta.url))])),
    },
  },
  // `npm run dev-relay` in cli/ answers the API here while you work on the account and admin pages.
  server: { proxy: { '/v1': 'http://127.0.0.1:8787' } },
});
```

- [ ] **Step 4: Create `site/src/page.ts`**

```ts
// Shared by every page: calls to the relay's API, the page-view beacon, the nav's Sign in link,
// and the formatters the account and admin pages both use.

export class ApiError extends Error {
  /** The HTTP status, or 0 when the relay couldn't be reached. */
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Call the relay on this site's origin. A failure carries the relay's own sentence. */
export async function api<T>(method: string, path: string, data?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: data === undefined ? undefined : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new ApiError(0, "Couldn't reach tunnel. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Something went wrong (${res.status}). Try again in a minute.`);
  return body as T;
}

/** The sentence to show for a failure. */
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Count this page view. No cookie: the relay keeps a daily count and the referring site's name. */
export function beacon() {
  try {
    navigator.sendBeacon('/v1/hit', JSON.stringify({ p: location.pathname, r: document.referrer }));
  } catch {
    // counting is best effort
  }
}

/** The nav says "Account" instead of "Sign in" once this browser has signed in. */
export function accountLink() {
  if (!/(?:^|;\s*)tunnel_signed_in=1(?:;|$)/.test(document.cookie)) return;
  for (const link of document.querySelectorAll('[data-account-link]')) link.textContent = 'Account';
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Same rounding as the CLI: 10 MB, 2 GB, 0 B. */
export function formatBytes(n: number): string {
  if (n >= GB) return `${+(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${+(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export const title = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

/** A date in the reader's own format, e.g. 9 Oct 2026. */
export const formatDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
```

- [ ] **Step 5: Create `site/src/app.css`**

```css
/* The account, admin and legal pages. Loaded after style.css; reuses its tokens. */

[hidden] {
  display: none !important;
}

/* The footer's own top margin spaces the end of the page. */
.page {
  padding-top: clamp(32px, 6vw, 72px);
}

.page-title {
  font: 400 clamp(2.25rem, 5vw, 3.5rem) / 1 var(--pixel);
  letter-spacing: -0.01em;
}

.page-lede {
  margin-top: 16px;
  max-width: var(--measure);
  color: var(--stone);
}

.page-lede code {
  color: var(--ink);
}

.page-subtitle {
  margin-top: 56px;
  font: 600 1.25rem/1.2 var(--sans);
  letter-spacing: -0.02em;
}

.status {
  margin-top: 24px;
  max-width: var(--measure);
  padding: 12px 16px;
  background: var(--haze);
  border-left: 3px solid var(--signal);
}

.status[data-tone='error'] {
  background: var(--paper);
  border: 1px solid var(--signal);
  border-left-width: 3px;
}

/* ---------- legal pages ---------- */

.legal {
  max-width: var(--measure);
}

.legal .updated {
  margin-top: 12px;
  color: var(--stone);
  font-size: 0.9375rem;
}

.legal h2 {
  margin-top: 40px;
  font: 600 1.25rem/1.25 var(--sans);
  letter-spacing: -0.02em;
}

.legal p,
.legal ul {
  margin-top: 12px;
}

.legal ul {
  padding-left: 1.25em;
}

.legal li + li {
  margin-top: 6px;
}
```

- [ ] **Step 6: Create `site/src/legal.ts`**

```ts
import './style.css';
import './app.css';
import { accountLink, beacon } from './page';

accountLink();
beacon();
```

- [ ] **Step 7: Create the legal pages**

These are drafts for the owner to review before the Lemon Squeezy store goes live; they are not legal advice. The handoff at the end of the plan lists what the owner must confirm (the contact address and the hosting provider).

`site/terms.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Terms of service | tunnel</title>
    <meta name="description" content="The terms for using tunnel's hosted relay and for paying for Plus or Pro." />
    <link rel="canonical" href="https://tunnel.dilyor.dev/terms" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <header class="nav wrap">
      <a class="brand" href="/" aria-label="tunnel home">
        <svg class="brand-mark" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M0 0h9v1H0zM0 8h9v1H0zM0 1h1v7H0zM8 1h1v7H8z" />
          <path d="M2 2h5v1H2zM2 6h5v1H2zM2 3h1v3H2zM6 3h1v3H6z" />
          <path d="M4 4h1v1H4z" />
        </svg>
        tunnel
      </a>
      <nav class="nav-links" aria-label="Main">
        <a href="/#pricing">Pricing</a>
        <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
        <a href="/account" data-account-link>Sign in</a>
      </nav>
    </header>

    <main class="page wrap">
      <!-- Draft for the owner to review before the store goes live. Not legal advice. -->
      <article class="legal">
        <h1 class="page-title">Terms of service</h1>
        <p class="updated">Last updated 9 October 2026</p>

        <h2>Who we are</h2>
        <p>
          tunnel is an open-source command-line tool and a hosted relay at tunnel.dilyor.dev, run by
          Dilyorbek, an independent developer based in Uzbekistan ("we"). These terms cover the hosted
          relay, this website and the Plus and Pro plans. The code itself is MIT licensed, and a relay
          you run yourself is not covered by these terms.
        </p>

        <h2>Using the relay</h2>
        <ul>
          <li>Use it only for lawful purposes.</li>
          <li>Don't send malware or spam through it, or material you have no right to share.</li>
          <li>Don't attack the relay, overload it, or work around plan limits and rate limits.</li>
        </ul>
        <p>We may close tunnels or accounts that break these rules.</p>

        <h2>Your content</h2>
        <p>
          Messages and files are encrypted on your machines with keys the relay never receives, so we
          can't read them. You keep every right to what you send, and you're responsible for what your
          agents send.
        </p>

        <h2>Accounts</h2>
        <p>
          You don't need an account for the Free plan. If you create one, you sign in with your email
          address or GitHub, and you're responsible for keeping that email or GitHub account secure.
        </p>

        <h2>Plans and payment</h2>
        <ul>
          <li>Plus costs $5 a month and Pro costs $9 a month.</li>
          <li>
            Lemon Squeezy sells the plans as our merchant of record. It takes the payment, charges
            any sales tax or VAT and sends your invoices, and its own terms also apply to the purchase.
          </li>
          <li>A subscription renews every month until you cancel it.</li>
          <li>
            You can cancel any time from Manage billing on your account page. The plan then runs to the
            end of the month you paid for.
          </li>
          <li>We'll email you at least 30 days before a price change applies to you.</li>
          <li>Refunds are covered by the <a href="/refund">refund policy</a>.</li>
        </ul>

        <h2>Limits and history</h2>
        <p>
          Each plan's limits are listed under <a href="/#pricing">Pricing</a>. Messages and files are
          deleted when the plan's history period ends (7 days on Free, 30 days on Plus and Pro),
          whether or not anyone read them. When a paid plan ends, the Free limits apply again: open
          tunnels stay open, but you can't open more than Free allows.
        </p>

        <h2>Availability</h2>
        <p>
          We run the relay as well as we can, but we don't promise any level of uptime. If we ever
          shut the hosted relay down, we'll tell paying customers by email at least 30 days ahead and
          refund the unused part of the current month.
        </p>

        <h2>No warranty</h2>
        <p>
          The service is provided "as is", without warranties of any kind. As far as the law allows,
          our total liability to you is limited to what you paid us in the 3 months before the claim.
        </p>

        <h2>Changes</h2>
        <p>
          If we change these terms in a way that matters, we'll email account holders at least 14 days
          before the change applies. The date at the top always shows the latest version.
        </p>

        <h2>Contact</h2>
        <p>Email <a href="mailto:tunnel@dilyor.dev">tunnel@dilyor.dev</a>.</p>
      </article>
    </main>

    <footer class="footer">
      <div class="wrap footer-row">
        <nav class="footer-links" aria-label="Footer">
          <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/refund">Refunds</a>
          <a href="https://dilyor.dev">dilyor.dev</a>
        </nav>
      </div>
    </footer>

    <script type="module" src="/src/legal.ts"></script>
  </body>
</html>
```

`site/privacy.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy policy | tunnel</title>
    <meta name="description" content="What tunnel's hosted relay and website store, for how long, and who processes it." />
    <link rel="canonical" href="https://tunnel.dilyor.dev/privacy" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <header class="nav wrap">
      <a class="brand" href="/" aria-label="tunnel home">
        <svg class="brand-mark" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M0 0h9v1H0zM0 8h9v1H0zM0 1h1v7H0zM8 1h1v7H8z" />
          <path d="M2 2h5v1H2zM2 6h5v1H2zM2 3h1v3H2zM6 3h1v3H6z" />
          <path d="M4 4h1v1H4z" />
        </svg>
        tunnel
      </a>
      <nav class="nav-links" aria-label="Main">
        <a href="/#pricing">Pricing</a>
        <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
        <a href="/account" data-account-link>Sign in</a>
      </nav>
    </header>

    <main class="page wrap">
      <!-- Draft for the owner to review before the store goes live. Not legal advice. -->
      <article class="legal">
        <h1 class="page-title">Privacy policy</h1>
        <p class="updated">Last updated 9 October 2026</p>

        <h2>Who we are</h2>
        <p>
          Dilyorbek, an independent developer based in Uzbekistan, runs tunnel.dilyor.dev. Questions go
          to <a href="mailto:tunnel@dilyor.dev">tunnel@dilyor.dev</a>.
        </p>

        <h2>What the relay stores</h2>
        <ul>
          <li>
            <strong>Tunnels:</strong> random ids for each tunnel and each agent in it, plus the
            encrypted messages and files with their sizes and times. Content is encrypted on your
            machines with keys the relay never receives. Messages and files are deleted after 7 days on
            Free and 30 days on Plus and Pro.
          </li>
          <li>
            <strong>Machines:</strong> a random id, a hash of its access token, and when it was created
            and last used.
          </li>
          <li>
            <strong>Accounts</strong>, only if you sign in: your email address, your GitHub user id and
            login if you use GitHub, your plan, the machines you linked, and when the account was
            created and last used. Each browser sign-in is stored as a hash of its token for 30 days.
          </li>
          <li>
            <strong>Billing:</strong> the Lemon Squeezy subscription id, plan, status and renewal dates.
            We never see your card details. A hash of each billing notification is kept for 90 days so
            none is applied twice.
          </li>
        </ul>

        <h2>Website statistics</h2>
        <p>
          The site uses no cookies for statistics and loads no tracking scripts from other companies.
          Each page view adds one to a daily count, and when you arrive from another site, that
          site's host name (for example news.ycombinator.com) is counted too. To count unique
          visitors, the relay keeps a hash of your IP address and browser name made with a key that
          changes every day; those hashes are deleted when the day ends. It also counts installs by
          type, and daily totals of messages, tunnels and sign-ups. To count active users, it notes
          which machine and agent ids (the random ones above) were used each day, and deletes those
          notes after 90 days. These are counts, never content.
        </p>

        <h2>IP addresses</h2>
        <p>
          The relay holds IP addresses only in memory, to rate-limit abuse, and never writes them to
          its database. The web server's access logs record IP addresses, the pages requested and
          browser names, and are deleted after 14 days.
        </p>

        <h2>Cookies</h2>
        <ul>
          <li><code>tunnel_session</code> keeps you signed in, for 30 days.</li>
          <li><code>tunnel_signed_in</code> lets pages show "Account" instead of "Sign in", for 30 days.</li>
          <li><code>tunnel_oauth</code> exists for 10 minutes during a GitHub sign-in.</li>
        </ul>
        <p>There are no advertising or analytics cookies.</p>

        <h2>Who processes your data</h2>
        <ul>
          <li><strong>Resend</strong> sends sign-in emails, so it receives your email address.</li>
          <li><strong>GitHub</strong> handles GitHub sign-in, if you choose it.</li>
          <li>
            <strong>Lemon Squeezy</strong> handles payments. Its own privacy policy covers what you give
            it at checkout.
          </li>
          <li><strong>Oracle Cloud</strong> hosts the server.</li>
        </ul>
        <p>These companies may process data outside your country.</p>

        <h2>Your choices</h2>
        <ul>
          <li>You can use tunnel without an account.</li>
          <li>You can unlink a machine or sign out at any time from your account page.</li>
          <li>
            Email us to get a copy of your account data or to have your account deleted. We answer
            within 30 days.
          </li>
        </ul>

        <h2>Changes</h2>
        <p>We'll post changes on this page and update the date at the top.</p>
      </article>
    </main>

    <footer class="footer">
      <div class="wrap footer-row">
        <nav class="footer-links" aria-label="Footer">
          <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/refund">Refunds</a>
          <a href="https://dilyor.dev">dilyor.dev</a>
        </nav>
      </div>
    </footer>

    <script type="module" src="/src/legal.ts"></script>
  </body>
</html>
```

`site/refund.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Refund policy | tunnel</title>
    <meta name="description" content="How to cancel tunnel Plus or Pro, and how to get a refund." />
    <link rel="canonical" href="https://tunnel.dilyor.dev/refund" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <header class="nav wrap">
      <a class="brand" href="/" aria-label="tunnel home">
        <svg class="brand-mark" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M0 0h9v1H0zM0 8h9v1H0zM0 1h1v7H0zM8 1h1v7H8z" />
          <path d="M2 2h5v1H2zM2 6h5v1H2zM2 3h1v3H2zM6 3h1v3H6z" />
          <path d="M4 4h1v1H4z" />
        </svg>
        tunnel
      </a>
      <nav class="nav-links" aria-label="Main">
        <a href="/#pricing">Pricing</a>
        <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
        <a href="/account" data-account-link>Sign in</a>
      </nav>
    </header>

    <main class="page wrap">
      <!-- Draft for the owner to review before the store goes live. Not legal advice. -->
      <article class="legal">
        <h1 class="page-title">Refund policy</h1>
        <p class="updated">Last updated 9 October 2026</p>

        <h2>Cancelling</h2>
        <p>
          Plus and Pro are monthly subscriptions sold through Lemon Squeezy. Cancel any time from Manage
          billing on your <a href="/account">account page</a>. You keep the plan until the end of the
          month you paid for, and you won't be charged again.
        </p>

        <h2>Refunds</h2>
        <p>
          If you're not happy with a charge, email
          <a href="mailto:tunnel@dilyor.dev">tunnel@dilyor.dev</a> within 14 days of it, from the
          address on your account, and we'll refund that charge in full. After 14 days, charges are not
          refunded, except where the law requires it or if we shut the hosted relay down (then we
          refund the unused part of the month).
        </p>
        <p>
          Refunds go back to the original payment method through Lemon Squeezy and usually arrive
          within 5 to 10 business days.
        </p>
      </article>
    </main>

    <footer class="footer">
      <div class="wrap footer-row">
        <nav class="footer-links" aria-label="Footer">
          <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/refund">Refunds</a>
          <a href="https://dilyor.dev">dilyor.dev</a>
        </nav>
      </div>
    </footer>

    <script type="module" src="/src/legal.ts"></script>
  </body>
</html>
```

In `vite.config.ts`, the legal pages are already in `PAGES` from Step 3.

- [ ] **Step 8: Update the landing page, `site/index.html`**

Make these edits, in order.

Nav: replace

```html
        <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
      </nav>
    </header>
```

with

```html
        <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
        <a href="/account" data-account-link>Sign in</a>
      </nav>
    </header>
```

The "tell your agent" hint: replace

```html
          <p class="hero-note">Installs to ~/.tunnel. Brings its own Node if yours is older than 22.13.</p>
```

with

```html
          <p class="hero-note">Installs to ~/.tunnel. Brings its own Node if yours is older than 22.13.</p>
          <p class="agent-hint">
            Or just tell your agent: <q>Install tunnel from tunnel.dilyor.dev</q>
            <button class="btn-text" type="button" data-copy="Install tunnel from tunnel.dilyor.dev">Copy</button>
          </p>
```

Feature "Messages wait": replace

```html
            <p>
              Agents work in turns. Messages stay in the tunnel's mailbox for up to 7 days until
              someone reads them.
            </p>
```

with

```html
            <p>
              Agents work in turns. Messages stay in the tunnel's mailbox until someone reads them:
              7 days on Free, 30 on Plus and Pro.
            </p>
```

Feature "Files too": replace

```html
            <p>Send schemas, diffs and logs up to 10&nbsp;MB alongside a message.</p>
```

with

```html
            <p>Send schemas, diffs and logs alongside a message: up to 10&nbsp;MB on Free, 100&nbsp;MB on Pro.</p>
```

Pricing: replace the whole `<section class="section wrap" id="pricing">…</section>` with

```html
      <section class="section wrap" id="pricing">
        <h2 class="section-title">Pricing</h2>
        <p class="section-lede">
          Free needs no account. Plus and Pro are monthly plans for one account and every machine
          linked to it. The code is open source either way.
        </p>
        <div class="plans">
          <article class="plan">
            <h3>Free</h3>
            <p class="price">$0</p>
            <ul>
              <li>1 tunnel per machine</li>
              <li>Files up to 10 MB</li>
              <li>7 days of history</li>
              <li>No account needed</li>
            </ul>
          </article>
          <article class="plan">
            <h3>Plus</h3>
            <p class="price">$5 <span>a month</span></p>
            <ul>
              <li>10 tunnels across your machines</li>
              <li>Files up to 50 MB</li>
              <li>30 days of history</li>
              <li>2 GB of file storage</li>
            </ul>
            <a class="btn" href="/account?plan=plus">Get Plus</a>
          </article>
          <article class="plan">
            <h3>Pro</h3>
            <p class="price">$9 <span>a month</span></p>
            <ul>
              <li>20 tunnels across your machines</li>
              <li>Files up to 100 MB</li>
              <li>30 days of history</li>
              <li>5 GB of file storage</li>
            </ul>
            <a class="btn" href="/account?plan=pro">Get Pro</a>
          </article>
          <article class="plan">
            <h3>Self-hosted</h3>
            <p class="price">$0</p>
            <ul>
              <li>Your relay, your limits</li>
              <li>Same CLI and skills</li>
              <li>MIT licensed</li>
            </ul>
          </article>
        </div>
        <p class="plans-note">
          Every agent in a tunnel gets the plan of whoever opened it. Payments go through Lemon
          Squeezy, which handles tax and invoices. Cancel any time from your account page.
        </p>
      </section>
```

FAQ "Do both agents need to be running at the same time?": replace its answer

```html
            <p>
              No. Messages wait in the tunnel's mailbox for up to 7 days. An agent picks them up
              with <code>tunnel inbox</code>, or blocks on <code>tunnel wait</code> until
              something arrives.
            </p>
```

with

```html
            <p>
              No. Messages wait in the tunnel's mailbox: 7 days on the Free plan, 30 days on Plus
              and Pro. An agent picks them up with <code>tunnel inbox</code>, or blocks on
              <code>tunnel wait</code> until something arrives.
            </p>
```

New FAQs: replace the end of the FAQ list

```html
          <details>
            <summary>How is this different from ngrok or an SSH tunnel?</summary>
            <p>
              Those forward network ports. tunnel carries conversations: who said what, the files
              that came with it, and a mailbox for agents that aren't running right now.
            </p>
          </details>
        </div>
```

with

```html
          <details>
            <summary>How is this different from ngrok or an SSH tunnel?</summary>
            <p>
              Those forward network ports. tunnel carries conversations: who said what, the files
              that came with it, and a mailbox for agents that aren't running right now.
            </p>
          </details>
          <details>
            <summary>Do I need an account?</summary>
            <p>
              No. Without one you're on the Free plan: one tunnel per machine, files up to 10 MB and
              7 days of history. An account is only for Plus and Pro; run <code>tunnel login</code>
              to link a machine to it.
            </p>
          </details>
          <details>
            <summary>What do Plus and Pro add?</summary>
            <p>
              More tunnels, shared across every machine linked to your account (10 on Plus, 20 on
              Pro), bigger files (50 MB or 100 MB), 30 days of history and file storage (2 GB or
              5 GB). Everyone in a tunnel gets the plan of the person who opened it. Plus is $5 a
              month and Pro is $9.
            </p>
          </details>
          <details>
            <summary>Can my agent install it for me?</summary>
            <p>
              Yes. Tell Claude Code or Codex “Install tunnel from tunnel.dilyor.dev”. It reads the
              install command for your system from this site, runs it, and can then run
              <code>tunnel skills install</code> so it knows the commands.
            </p>
          </details>
        </div>
```

Footer: replace

```html
          <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
          <a href="https://dilyor.dev">dilyor.dev</a>
        </nav>
```

with

```html
          <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/refund">Refunds</a>
          <a href="https://dilyor.dev">dilyor.dev</a>
        </nav>
```

- [ ] **Step 9: Style the new pieces, in `site/src/style.css`**

After the `.hero-note { … }` rule, add:

```css
.agent-hint {
  margin-top: 8px;
  font-size: 0.9375rem;
  color: var(--stone);
}

.agent-hint q {
  color: var(--ink);
}

.btn-text {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--signal);
  font: 500 0.9375rem var(--sans);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
```

After the `.btn:hover { … }` rule, add:

```css
.plan .btn {
  margin-top: 24px;
}

.plans-note {
  margin-top: 24px;
  max-width: var(--measure);
  color: var(--stone);
  font-size: 0.9375rem;
}
```

In `.footer-links`, replace `gap: 24px;` with:

```css
  flex-wrap: wrap;
  gap: 12px 24px;
```

- [ ] **Step 10: Send the beacon and update the nav link, in `site/src/main.ts`**

Under `import { mountWormhole, type Message } from './wormhole';`, add:

```ts
import { accountLink, beacon } from './page';
```

At the end of the file, add:

```ts
// ---------- account link and page view ----------

accountLink();
beacon();
```

- [ ] **Step 11: Update `site/public/robots.txt` and `site/public/llms.txt`**

`robots.txt` becomes:

```
# Search engines and AI assistants are welcome; the relay API and signed-in pages are not pages to index.
User-agent: *
Allow: /
Disallow: /v1/
Disallow: /account
Disallow: /admin

Sitemap: https://tunnel.dilyor.dev/sitemap.xml
```

In `llms.txt`, replace the `tunnel send` line with:

```
- `tunnel send "text" [--to peer] [--file path]` sends a message, optionally with a file (up to 10 MB on Free, 50 MB on Plus, 100 MB on Pro).
```

Add after the `tunnel help` line:

```
- `tunnel login` links a machine to an account; `tunnel account` shows the plan and usage; `tunnel upgrade` shows the paid plans.
```

Replace the Docs pricing line with:

```
- [Pricing](https://tunnel.dilyor.dev/#pricing): Free, Plus, Pro and self-hosting
```

Add these two sections at the end of the `## Docs` section, before `## Facts`:

```
## Pricing

- Free: no account, 1 tunnel per machine, files up to 10 MB, 7 days of history.
- Plus: $5 a month, 10 tunnels across an account's machines, files up to 50 MB, 30 days of history, 2 GB of storage.
- Pro: $9 a month, 20 tunnels, files up to 100 MB, 30 days of history, 5 GB of storage.
- Self-hosted: free, `tunnel relay` runs your own relay with your own limits.

## For agents asked to install tunnel

1. On macOS or Linux run `curl -fsSL https://tunnel.dilyor.dev/install.sh | sh`. On Windows run `irm https://tunnel.dilyor.dev/install.ps1 | iex` in PowerShell.
2. Run `tunnel skills install` so Claude Code and Codex learn the commands.
3. Run `tunnel help` to see every command. Don't run `tunnel login` or `tunnel upgrade` unless your user asks.
```

In `## Facts`, replace the 7-day line with:

```
- Messages wait in the tunnel's mailbox for 7 days on Free and 30 days on Plus and Pro, so agents do not need to run at the same time.
```

- [ ] **Step 12: Run the check**

Run: `cd site && npm run build && npm run check`
Expected: `Site check passed: 4 pages.`

- [ ] **Step 13: Look at it**

Start the `site` server from `.claude/launch.json` and open `http://localhost:5173/`. Check at desktop width and at 375 px:
- the nav shows Pricing, GitHub and Sign in (How it works is hidden at 375 px), and nothing scrolls sideways;
- under the install box, "Or just tell your agent" sits on its own line and its Copy button copies the sentence (it reads Copied, then Copy again);
- four plan cards, two per row below 900 px and one per row below 560 px, with Get Plus and Get Pro buttons;
- `/terms`, `/privacy` and `/refund` load with the same header and footer.

(The beacon's `POST /v1/hit` fails in the console when no relay runs on 8787. That's expected here; Task 11 adds the dev relay.)

- [ ] **Step 14: Commit**

```bash
git add site/scripts/check.mjs site/package.json site/vite.config.ts site/src/page.ts site/src/app.css site/src/legal.ts site/terms.html site/privacy.html site/refund.html site/index.html site/src/style.css site/src/main.ts site/public/robots.txt site/public/llms.txt
git commit -m "feat(site): Plus and Pro pricing, agent install hint, legal pages, multi-page build" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The account page, and a dev relay to build it against

**Files:**
- Create: `cli/scripts/dev-relay.ts`
- Modify: `cli/package.json` (`dev-relay` script), `cli/tsconfig.json` (include `scripts`)
- Modify: `.claude/launch.json`, `.gitignore`
- Modify: `site/src/page.ts` (`byId`, `say`, `button`)
- Create: `site/account.html`, `site/src/account.ts`
- Modify: `site/src/app.css` (account styles)
- Modify: `site/vite.config.ts`, `site/scripts/check.mjs` (add `'account'` to `PAGES`)

**Interfaces:**
- Consumes: `GET /v1/auth/methods`, `POST /v1/auth/email`, `POST /v1/auth/email/verify`, `GET /v1/auth/github/start?return=`, the `?error=` codes `github-state`, `github-denied`, `github`, `github-email`, `POST /v1/auth/logout`, `GET /v1/account`, `POST /v1/account/devices/:id/unlink` (Tasks 5–6), `POST /v1/account/devices/link` (Task 7), `POST /v1/account/checkout`, `GET /v1/account/portal` (Task 8); `startRelay` options `env`, `fetch`, `linkPollSeconds` (Task 2); `page.ts` (Task 10).
- Produces:
  - `page.ts` additions: `byId<T extends HTMLElement = HTMLElement>(id): T`, `say(text, tone?: 'ok' | 'error')` (writes to the page's `#status`), `button(label, onClick, quiet?): HTMLButtonElement` (disables itself while `onClick` runs and shows a failure with `say`). Task 12 uses all three.
  - `app.css` additions: `button.btn`, `.btn-quiet`, `.actions`, `.card`, `.code`, `.facts`, `.sign-in`, `.field-row`, `.table-wrap`, `.table`. Task 12 reuses `.table`, `.table-wrap`, `.actions` and `.btn-quiet`.
  - `npm run dev-relay` (in `cli/`): a relay on 127.0.0.1:8787 with every feature on, Resend and Lemon Squeezy faked, data in `cli/dev-data/`, admin `dev@example.com`.

- [ ] **Step 1: Add the page to the check, so it fails**

In `site/scripts/check.mjs`, change `PAGES` to:

```js
const PAGES = ['index', 'terms', 'privacy', 'refund', 'account'];
```

Run: `cd site && npm run build && npm run check`
Expected: FAIL with `dist/account.html is missing`.

- [ ] **Step 2: Create the dev relay, `cli/scripts/dev-relay.ts`**

```ts
import { createHmac } from 'node:crypto';
import { startRelay } from '../src/relay/server.js';

// A relay for working on the site, with every feature on and the outside services faked:
// sign-in emails are printed here instead of sent, and checkout "pays" at once by sending this
// relay a signed webhook. Run `npm run dev-relay`, then the site's dev server on port 5173.
// Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from a dev OAuth app to try GitHub sign-in too.

const SITE = 'http://localhost:5173';
const PORT = 8787;
const SECRET = 'dev-webhook-secret';
const DAY = 24 * 60 * 60 * 1000;

const env = {
  TUNNEL_PUBLIC_URL: SITE,
  RESEND_API_KEY: 'dev',
  TUNNEL_EMAIL_FROM: 'tunnel <login@localhost>',
  LEMONSQUEEZY_API_KEY: 'dev',
  LEMONSQUEEZY_STORE_ID: '1',
  LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
  LEMONSQUEEZY_VARIANT_PLUS: '1001',
  LEMONSQUEEZY_VARIANT_PRO: '1002',
  TUNNEL_ADMIN_EMAILS: 'dev@example.com',
  TUNNEL_STATS_SALT: 'dev',
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
};

/** What Lemon Squeezy would send once a checkout is paid. */
async function paid(accountId: string, variantId: string) {
  const raw = JSON.stringify({
    meta: { event_name: 'subscription_created', custom_data: { account_id: accountId } },
    data: {
      type: 'subscriptions',
      id: `sub_dev_${Date.now()}`,
      attributes: {
        variant_id: Number(variantId),
        status: 'active',
        renews_at: new Date(Date.now() + 30 * DAY).toISOString(),
        ends_at: null,
        updated_at: new Date().toISOString(),
      },
    },
  });
  await fetch(`http://127.0.0.1:${PORT}/v1/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', SECRET).update(raw).digest('hex') },
    body: raw,
  });
}

const fake = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  if (url === 'https://api.resend.com/emails') {
    console.log(`\nSign-in link for ${body.to.join(', ')}:\n${/https?:\/\/\S+/.exec(body.text)?.[0]}\n`);
    return Response.json({ id: 'dev' });
  }
  if (url === 'https://api.lemonsqueezy.com/v1/checkouts') {
    await paid(body.data.attributes.checkout_data.custom.account_id, body.data.relationships.variant.data.id);
    return Response.json({ data: { attributes: { url: `${SITE}/account?upgraded=1` } } });
  }
  if (url.startsWith('https://api.lemonsqueezy.com/v1/subscriptions/')) {
    return Response.json({ data: { attributes: { urls: { customer_portal: `${SITE}/account` } } } });
  }
  return globalThis.fetch(input, init);
}) as typeof fetch;

const relay = await startRelay({
  port: PORT,
  host: '127.0.0.1',
  dataDir: 'dev-data',
  env,
  fetch: fake,
  maxTunnelsPerDevice: 1,
  linkPollSeconds: 1,
});
console.log(`Dev relay on ${relay.url}. Open ${SITE}/account and sign in as dev@example.com to see the admin page too.`);
console.log(`Point the CLI at it with TUNNEL_RELAY=${relay.url}`);
```

In `cli/package.json` `scripts`, add after `"tunnel"`:

```json
    "dev-relay": "tsx scripts/dev-relay.ts",
```

In `cli/tsconfig.json`, change `"include"` to `["src", "test", "scripts"]`.

In `.gitignore`, add a line:

```
dev-data/
```

In `.claude/launch.json`, add a second configuration after `site`:

```json
    {
      "name": "dev-relay",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev-relay", "--prefix", "cli"],
      "port": 8787
    }
```

Run: `cd cli && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Add the shared page helpers to `site/src/page.ts`**

Append:

```ts
export const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** One plain sentence in the page's #status line. */
export function say(text: string, tone: 'ok' | 'error' = 'ok') {
  const status = byId('status');
  status.textContent = text;
  status.dataset.tone = tone;
  status.hidden = false;
}

/** A button that is disabled while its action runs, and reports a failure in #status. */
export function button(label: string, onClick: () => unknown, quiet = false): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = quiet ? 'btn btn-quiet' : 'btn';
  el.textContent = label;
  el.addEventListener('click', async () => {
    el.disabled = true;
    try {
      await onClick();
    } catch (error) {
      say(messageOf(error), 'error');
    } finally {
      el.disabled = false;
    }
  });
  return el;
}
```

- [ ] **Step 4: Create `site/account.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Account | tunnel</title>
    <meta name="robots" content="noindex" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <header class="nav wrap">
      <a class="brand" href="/" aria-label="tunnel home">
        <svg class="brand-mark" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M0 0h9v1H0zM0 8h9v1H0zM0 1h1v7H0zM8 1h1v7H8z" />
          <path d="M2 2h5v1H2zM2 6h5v1H2zM2 3h1v3H2zM6 3h1v3H6z" />
          <path d="M4 4h1v1H4z" />
        </svg>
        tunnel
      </a>
      <nav class="nav-links" aria-label="Main">
        <a href="/#pricing">Pricing</a>
        <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
      </nav>
    </header>

    <main class="page wrap">
      <h1 class="page-title">Account</h1>
      <p class="status" id="status" role="status" hidden></p>

      <section id="signed-out" hidden>
        <p class="page-lede">
          Sign in to pay for Plus or Pro and to see the machines linked to your account. The Free
          plan needs no account.
        </p>
        <div class="sign-in">
          <a class="btn" id="github" href="/v1/auth/github/start" hidden>Continue with GitHub</a>
          <form class="email-form" id="email-form" hidden>
            <label for="email">Email</label>
            <div class="field-row">
              <input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
              <button class="btn" type="submit">Email me a sign-in link</button>
            </div>
          </form>
          <p class="page-lede" id="email-sent" hidden>Check your inbox for the sign-in link. It works for 15 minutes.</p>
        </div>
      </section>

      <section class="card" id="link-card" hidden>
        <h2>Link a machine</h2>
        <p>
          A machine running <code>tunnel login</code> wants to join your account. Link it only if
          this code matches the one in its terminal.
        </p>
        <p class="code" id="link-code"></p>
        <div class="actions">
          <button class="btn" id="link-confirm" type="button">Link this machine</button>
          <button class="btn btn-quiet" id="link-cancel" type="button">Cancel</button>
        </div>
      </section>

      <section id="signed-in" hidden>
        <dl class="facts">
          <div><dt>Email</dt><dd id="me-email"></dd></div>
          <div><dt>Plan</dt><dd id="me-plan"></dd></div>
          <div><dt>Tunnels</dt><dd id="me-tunnels"></dd></div>
          <div><dt>Files</dt><dd id="me-files"></dd></div>
          <div><dt>History</dt><dd id="me-history"></dd></div>
        </dl>
        <div class="actions" id="plan-actions"></div>

        <h2 class="page-subtitle">Machines</h2>
        <p class="page-lede" id="no-machines">No machines yet. Run <code>tunnel login</code> on one to link it.</p>
        <div class="table-wrap">
          <table class="table" id="machines" hidden>
            <thead>
              <tr>
                <th scope="col">Machine</th>
                <th scope="col">Tunnels</th>
                <th scope="col">Last used</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>

        <div class="actions">
          <a class="btn btn-quiet" id="admin-link" href="/admin" hidden>Admin</a>
          <button class="btn btn-quiet" id="sign-out" type="button">Sign out</button>
        </div>
      </section>
    </main>

    <footer class="footer">
      <div class="wrap footer-row">
        <nav class="footer-links" aria-label="Footer">
          <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/refund">Refunds</a>
          <a href="https://dilyor.dev">dilyor.dev</a>
        </nav>
      </div>
    </footer>

    <script type="module" src="/src/account.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `site/src/account.ts`**

```ts
import './style.css';
import './app.css';
import { ApiError, api, beacon, button, byId, formatBytes, formatDay, messageOf, say, title } from './page';

// The account page. Signed out: the sign-in methods this relay has. Signed in: plan, usage,
// linked machines and billing. It also finishes flows that start elsewhere, via the address bar:
//   ?login=TOKEN    an emailed sign-in link, spent here with a POST so mail scanners can't use it up
//   ?link=CODE      a machine running `tunnel login`, waiting for this account to confirm
//   ?plan=plus|pro  the pricing buttons: go to checkout as soon as the person is signed in
//   ?upgraded=1     back from checkout
//   ?error=CODE     a GitHub sign-in that failed

type Plan = 'free' | 'plus' | 'pro';

interface Me {
  email: string;
  githubLogin: string | null;
  plan: Plan;
  planSource: 'billing' | 'admin' | null;
  planUntil: number | null;
  limits: { tunnels: number; perDevice: boolean; fileBytes: number; historyDays: number; storageBytes: number };
  usage: { tunnels: number; storageBytes: number };
  devices: { id: string; created: number; seen: number | null; tunnels: number }[];
  subscription: { plan: Plan; status: string; renewsAt: number | null; endsAt: number | null } | null;
  admin: boolean;
}

interface Methods {
  github: boolean;
  email: boolean;
  billing: boolean;
}

const PRICES = { plus: 5, pro: 9 } as const;
const RANK: Record<Plan, number> = { free: 0, plus: 1, pro: 2 };

const ERRORS: Record<string, string> = {
  'github-state': 'That sign-in took too long or started in another browser. Try again.',
  'github-denied': 'GitHub sign-in was cancelled.',
  github: "GitHub didn't answer. Try again in a minute.",
  'github-email': 'Your GitHub account has no verified primary email. Add one on GitHub, or sign in with email.',
};

const params = new URLSearchParams(location.search);

/** Take handled flags out of the address bar, so a reload doesn't repeat them. */
function forget(...names: string[]) {
  const url = new URL(location.href);
  for (const name of names) url.searchParams.delete(name);
  history.replaceState(null, '', url.pathname + url.search);
}

function wantedPlan(): 'plus' | 'pro' | undefined {
  const plan = params.get('plan');
  return plan === 'plus' || plan === 'pro' ? plan : undefined;
}

/** Sign-in comes back here, with any ?plan or ?link still waiting. */
const here = () => location.pathname + location.search;

async function load(): Promise<Me | undefined> {
  try {
    return await api<Me>('GET', '/v1/account');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return undefined;
    throw error;
  }
}

async function checkout(plan: 'plus' | 'pro') {
  const { url } = await api<{ url: string }>('POST', '/v1/account/checkout', { plan });
  location.assign(url);
}

// ---------- signed out ----------

function showSignedOut(methods: Methods) {
  byId('signed-out').hidden = false;
  const github = byId<HTMLAnchorElement>('github');
  github.href = `/v1/auth/github/start?return=${encodeURIComponent(here())}`;
  github.hidden = !methods.github;
  const form = byId<HTMLFormElement>('email-form');
  form.hidden = !methods.email;

  const plan = wantedPlan();
  if (!methods.github && !methods.email) say("Sign-in isn't set up on this relay yet.");
  else if (params.has('link')) say('Sign in to link your machine.');
  else if (plan) say(`Sign in to get ${title(plan)}.`);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button')!;
    submit.disabled = true;
    try {
      await api('POST', '/v1/auth/email', { email: byId<HTMLInputElement>('email').value, return: here() });
      form.hidden = true;
      github.hidden = true;
      byId('email-sent').hidden = false;
    } catch (error) {
      say(messageOf(error), 'error');
    } finally {
      submit.disabled = false;
    }
  });
}

// ---------- signed in ----------

function planLine(me: Me): string {
  const name = title(me.plan);
  if (me.planSource === 'admin') return me.planUntil ? `${name} until ${formatDay(me.planUntil)}` : name;
  const sub = me.subscription;
  if (sub?.endsAt) return `${name}, ends ${formatDay(sub.endsAt)}`;
  if (sub?.renewsAt) return `${name}, renews ${formatDay(sub.renewsAt)}`;
  return name;
}

function tunnelsLine({ limits, usage }: Me): string {
  if (limits.tunnels === 0) return `${usage.tunnels} open`;
  if (limits.perDevice) return `${usage.tunnels} open, ${limits.tunnels} per machine`;
  return `${usage.tunnels} of ${limits.tunnels}`;
}

function filesLine({ limits, usage }: Me): string {
  const each = `Up to ${formatBytes(limits.fileBytes)} each`;
  if (!limits.storageBytes) return each;
  return `${each}, ${formatBytes(usage.storageBytes)} of ${formatBytes(limits.storageBytes)} stored`;
}

function planActions(me: Me, methods: Methods) {
  const actions = byId('plan-actions');
  actions.replaceChildren();
  if (me.subscription) {
    // Plan changes and cancelling happen in Lemon Squeezy's portal; its links expire, so fetch one now.
    actions.append(
      button('Manage billing', async () => {
        const { url } = await api<{ url: string }>('GET', '/v1/account/portal');
        location.assign(url);
      }),
    );
    return;
  }
  if (!methods.billing) return;
  for (const plan of ['plus', 'pro'] as const) {
    if (RANK[plan] > RANK[me.plan]) {
      actions.append(button(`Get ${title(plan)}, $${PRICES[plan]} a month`, () => checkout(plan)));
    }
  }
}

function showMachines(me: Me, refresh: () => Promise<void>) {
  const table = byId<HTMLTableElement>('machines');
  const rows = me.devices.map((device) => {
    const row = document.createElement('tr');
    const id = document.createElement('code');
    id.textContent = device.id;
    const cells = [id, String(device.tunnels), device.seen ? formatDay(device.seen) : 'Not yet'];
    for (const content of cells) {
      const td = document.createElement('td');
      td.append(content);
      row.append(td);
    }
    const actions = document.createElement('td');
    actions.append(
      button(
        'Unlink',
        async () => {
          await api('POST', `/v1/account/devices/${encodeURIComponent(device.id)}/unlink`);
          say(`Unlinked ${device.id}. Its tunnels stay open on the Free plan's limits.`);
          await refresh();
        },
        true,
      ),
    );
    row.append(actions);
    return row;
  });
  table.tBodies[0].replaceChildren(...rows);
  table.hidden = rows.length === 0;
  byId('no-machines').hidden = rows.length > 0;
}

function showSignedIn(me: Me, methods: Methods, refresh: () => Promise<void>) {
  byId('signed-in').hidden = false;
  byId('me-email').textContent = me.githubLogin ? `${me.email} (GitHub: ${me.githubLogin})` : me.email;
  byId('me-plan').textContent = planLine(me);
  byId('me-tunnels').textContent = tunnelsLine(me);
  byId('me-files').textContent = filesLine(me);
  byId('me-history').textContent = `${me.limits.historyDays} days`;
  planActions(me, methods);
  showMachines(me, refresh);
  byId('admin-link').hidden = !me.admin;
}

function showLinkCard(code: string, refresh: () => Promise<void>) {
  const card = byId('link-card');
  byId('link-code').textContent = code;
  card.hidden = false;
  const close = () => {
    card.hidden = true;
    forget('link');
  };
  byId('link-cancel').addEventListener('click', close, { once: true });
  const confirm = byId<HTMLButtonElement>('link-confirm');
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      await api('POST', '/v1/account/devices/link', { userCode: code });
      close();
      say('Machine linked. Its terminal will say so in a few seconds.');
      await refresh();
    } catch (error) {
      close();
      say(messageOf(error), 'error');
    } finally {
      confirm.disabled = false;
    }
  });
}

// ---------- start ----------

byId('sign-out').addEventListener('click', async () => {
  try {
    await api('POST', '/v1/auth/logout');
    location.assign('/');
  } catch (error) {
    say(messageOf(error), 'error');
  }
});

async function main() {
  beacon();

  const login = params.get('login');
  if (login) {
    try {
      const { returnTo } = await api<{ returnTo: string }>('POST', '/v1/auth/email/verify', { token: login });
      location.replace(returnTo);
      return;
    } catch (error) {
      forget('login');
      say(messageOf(error), 'error');
    }
  }
  const error = params.get('error');
  if (error) {
    forget('error');
    say(ERRORS[error] ?? 'Sign-in failed. Try again.', 'error');
  }
  const upgraded = params.has('upgraded');
  if (upgraded) {
    forget('upgraded');
    say('Payment received. Your new plan shows here as soon as Lemon Squeezy confirms it, usually within a minute.');
  }

  let methods: Methods;
  let me: Me | undefined;
  try {
    methods = await api<Methods>('GET', '/v1/auth/methods');
    me = await load();
  } catch (error) {
    say(error instanceof ApiError && error.status === 404 ? "This relay doesn't have accounts." : messageOf(error), 'error');
    return;
  }
  if (!me) return showSignedOut(methods);

  const plan = wantedPlan();
  if (plan) {
    forget('plan');
    if (RANK[plan] <= RANK[me.plan]) say(`You're already on ${title(me.plan)}.`);
    else {
      try {
        return await checkout(plan);
      } catch (error) {
        say(messageOf(error), 'error');
      }
    }
  }

  const refresh = async () => {
    const fresh = await load();
    if (fresh) showSignedIn(fresh, methods, refresh);
    else location.reload();
  };
  showSignedIn(me, methods, refresh);
  const link = params.get('link');
  if (link) showLinkCard(link, refresh);

  // The webhook can land a few seconds after the redirect back from checkout.
  if (upgraded && me.plan === 'free') {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const fresh = await load().catch(() => undefined);
      if (fresh && fresh.plan !== 'free') {
        showSignedIn(fresh, methods, refresh);
        say(`You're on ${title(fresh.plan)} now.`);
        break;
      }
    }
  }
}

main();
```

- [ ] **Step 6: Style the account page, in `site/src/app.css`**

Append:

```css
/* ---------- buttons, cards and tables ---------- */

button.btn {
  border: 0;
  font-family: var(--sans);
  cursor: pointer;
}

button.btn:disabled {
  opacity: 0.6;
  cursor: progress;
}

.btn-quiet {
  background: var(--paper);
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--ink);
}

.btn-quiet:hover {
  background: var(--haze);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.actions .btn,
.sign-in .btn,
.field-row .btn,
.table .btn {
  margin-top: 0;
}

.card {
  margin-top: 32px;
  max-width: var(--measure);
  padding: 24px;
  background: var(--haze);
  clip-path: var(--pixel-corners);
}

.card h2 {
  font: 600 1.25rem/1.2 var(--sans);
}

.card p {
  margin-top: 12px;
}

.code {
  font: 400 2rem/1.2 var(--pixel);
  letter-spacing: 0.06em;
}

/* ---------- account ---------- */

.sign-in {
  margin-top: 32px;
  display: grid;
  justify-items: start;
  gap: 28px;
}

.email-form {
  width: 100%;
  max-width: 32rem;
}

.email-form label {
  font-size: 0.9375rem;
  color: var(--stone);
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.field-row input,
.search input {
  flex: 1 1 14rem;
  min-width: 0;
  padding: 13px 14px;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font: 400 1rem var(--sans);
}

.facts {
  margin: 32px 0 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 10px 32px;
  max-width: var(--measure);
}

.facts div {
  display: contents;
}

.facts dt {
  color: var(--stone);
}

.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.table-wrap {
  margin-top: 16px;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9375rem;
}

.table th {
  text-align: left;
  font-weight: 500;
  color: var(--stone);
  border-bottom: 1px solid var(--ink);
  padding: 8px 16px 8px 0;
  white-space: nowrap;
}

.table td {
  padding: 10px 16px 10px 0;
  border-bottom: 1px solid var(--rule);
  vertical-align: middle;
}

.table .btn {
  padding: 8px 14px;
}
```

- [ ] **Step 7: Add the page to the build, in `site/vite.config.ts`**

```ts
const PAGES = ['index', 'terms', 'privacy', 'refund', 'account'];
```

- [ ] **Step 8: Run the check**

Run: `cd site && npm run build && npm run check`
Expected: `Site check passed: 5 pages.`

- [ ] **Step 9: Try every state in a browser**

Start `dev-relay` and `site` from `.claude/launch.json`. Then, at `http://localhost:5173`:

1. `/account` shows the email form and no GitHub button (unless GitHub variables are set). The nav has Pricing and GitHub.
2. Submit `dev@example.com`: the form is replaced by "Check your inbox…". The dev relay's log prints a sign-in link; open it. The page lands signed in: Email `dev@example.com`, Plan `Free`, Tunnels `0 open, 1 per machine`, Files `Up to 10 MB each`, History `7 days`, buttons `Get Plus, $5 a month` and `Get Pro, $9 a month`, "No machines yet", and Admin and Sign out.
3. Link a machine. In a terminal (Git Bash), from `cli/`:
   ```bash
   TUNNEL_HOME="$(mktemp -d)" TUNNEL_RELAY=http://127.0.0.1:8787 npx tsx src/bin.ts login
   ```
   Open the printed `http://localhost:5173/account?link=…` link. The card shows the same code; Link this machine. The terminal prints `Linked to dev@example.com (Free).` and the Machines table lists one row.
4. Get Plus. The page returns to `/account` with the payment sentence, and within a few seconds Plan reads `Plus, renews <date>`, Tunnels `0 of 10`, Files `Up to 50 MB each, 0 B of 2 GB stored`, and the only plan button is Manage billing (it reloads the account page, the dev portal).
5. Open `/account?plan=pro`: the status reads "You already have a subscription. Change plans from Manage billing on your account page."
6. Open `/account?error=github-state`: the status reads "That sign-in took too long or started in another browser. Try again."
7. Unlink the machine: the row disappears and the status names it.
8. At 375 px wide nothing scrolls sideways; the machines table scrolls inside its box if it must.
9. Sign out: you land on `/`, and the nav says Sign in again.

- [ ] **Step 10: Commit**

```bash
git add cli/scripts/dev-relay.ts cli/package.json cli/tsconfig.json .claude/launch.json .gitignore site/src/page.ts site/account.html site/src/account.ts site/src/app.css site/vite.config.ts site/scripts/check.mjs
git commit -m "feat(site): account page, and a dev relay with faked email and billing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The admin page

**Files:**
- Create: `site/src/chart.ts`
- Create: `site/admin.html`, `site/src/admin.ts`
- Modify: `site/src/app.css` (admin styles)
- Modify: `site/vite.config.ts`, `site/scripts/check.mjs` (add `'admin'` to `PAGES`)

**Interfaces:**
- Consumes: `GET /v1/admin/stats`, `GET /v1/admin/accounts`, `POST /v1/admin/accounts/:id/plan` (Task 9); `api`, `ApiError`, `accountLink`, `beacon`, `byId`, `say`, `button`, `formatDay`, `messageOf`, `title` (Tasks 10–11); `.table`, `.table-wrap`, `.btn-quiet` (Task 11).
- Produces: `chart.ts`: `interface Line { label: string; values: number[]; color: string }`, `niceMax(n: number): number`, `lineChart(name: string, days: string[], lines: Line[]): HTMLElement`.

- [ ] **Step 1: Add the page to the check, so it fails**

In `site/scripts/check.mjs`:

```js
const PAGES = ['index', 'terms', 'privacy', 'refund', 'account', 'admin'];
```

Run: `cd site && npm run build && npm run check`
Expected: FAIL with `dist/admin.html is missing`.

- [ ] **Step 2: Create `site/src/chart.ts`**

```ts
// A small line chart in inline SVG: one or more series over the same days, gridlines at zero, half
// and the top, the first and last day, and a legend with today's value. No chart library.

export interface Line {
  label: string;
  values: number[];
  /** Any CSS color, e.g. 'var(--signal)'. */
  color: string;
}

const W = 400;
const H = 150;
const PAD = { top: 10, right: 6, bottom: 24, left: 36 };
const NS = 'http://www.w3.org/2000/svg';

/** The top of the axis: 4, or 1, 2, 4, 6, 8 or 10 times a power of ten, so the halfway line is a whole number. */
export function niceMax(n: number): number {
  if (n <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * power >= n) return m * power;
  return 10 * power;
}

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>, text?: string) {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** '2026-10-09' → '9 Oct', in the reader's own format. */
const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function lineChart(name: string, days: string[], lines: Line[]): HTMLElement {
  const max = niceMax(Math.max(0, ...lines.flatMap((line) => line.values)));
  const last = days.length - 1;
  const x = (i: number) => PAD.left + (last === 0 ? 0 : (i / last) * (W - PAD.left - PAD.right));
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);

  const summary = lines
    .map((line) => `${line.label}: ${line.values.at(-1) ?? 0} today, ${line.values.reduce((a, b) => a + b, 0)} in ${days.length} days`)
    .join('; ');
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${name}. ${summary}.` });

  for (const v of [0, max / 2, max]) {
    chart.append(
      svg('line', { x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v), class: v === 0 ? 'chart-axis' : 'chart-grid' }),
      svg('text', { x: PAD.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-label' }, v.toLocaleString()),
    );
  }
  for (const line of lines) {
    const points = line.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const polyline = svg('polyline', { points, class: 'chart-line' });
    polyline.style.stroke = line.color;
    chart.append(polyline);
  }
  chart.append(
    svg('text', { x: x(0), y: H - 6, class: 'chart-label' }, shortDay(days[0])),
    svg('text', { x: x(last), y: H - 6, 'text-anchor': 'end', class: 'chart-label' }, shortDay(days[last])),
  );

  const figure = document.createElement('figure');
  figure.className = 'chart';
  const caption = document.createElement('figcaption');
  caption.textContent = name;
  const legend = document.createElement('ul');
  legend.className = 'chart-legend';
  for (const line of lines) {
    const item = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'chart-swatch';
    swatch.style.background = line.color;
    item.append(swatch, `${line.label} ${(line.values.at(-1) ?? 0).toLocaleString()} today`);
    legend.append(item);
  }
  figure.append(caption, chart, legend);
  return figure;
}
```

- [ ] **Step 3: Create `site/admin.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Admin | tunnel</title>
    <meta name="robots" content="noindex" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <header class="nav wrap">
      <a class="brand" href="/" aria-label="tunnel home">
        <svg class="brand-mark" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M0 0h9v1H0zM0 8h9v1H0zM0 1h1v7H0zM8 1h1v7H8z" />
          <path d="M2 2h5v1H2zM2 6h5v1H2zM2 3h1v3H2zM6 3h1v3H6z" />
          <path d="M4 4h1v1H4z" />
        </svg>
        tunnel
      </a>
      <nav class="nav-links" aria-label="Main">
        <a href="/#pricing">Pricing</a>
        <a href="/account" data-account-link>Sign in</a>
      </nav>
    </header>

    <main class="page wrap">
      <h1 class="page-title">Admin</h1>
      <p class="status" id="status" role="status" hidden></p>

      <p class="page-lede" id="denied" hidden>
        This page is for the relay's admins. <a href="/account">Go to your account</a>.
      </p>

      <div id="admin" hidden>
        <section aria-labelledby="today-title">
          <h2 class="page-subtitle" id="today-title">Today</h2>
          <dl class="numbers" id="today"></dl>
        </section>

        <section aria-labelledby="active-title">
          <h2 class="page-subtitle" id="active-title">Active</h2>
          <div class="table-wrap">
            <table class="table" id="active">
              <thead>
                <tr>
                  <th scope="col"><span class="sr-only">Who</span></th>
                  <th scope="col">Today</th>
                  <th scope="col">7 days</th>
                  <th scope="col">30 days</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="plans-title">
          <h2 class="page-subtitle" id="plans-title">Plans</h2>
          <dl class="numbers" id="plans"></dl>
        </section>

        <section aria-labelledby="charts-title">
          <h2 class="page-subtitle" id="charts-title">Last 30 days</h2>
          <div class="charts" id="charts"></div>
        </section>

        <section aria-labelledby="referrers-title">
          <h2 class="page-subtitle" id="referrers-title">Top referrers</h2>
          <p class="page-lede" id="no-referrers" hidden>No other sites sent visitors in the last 30 days.</p>
          <div class="table-wrap">
            <table class="table" id="referrers">
              <thead>
                <tr><th scope="col">Site</th><th scope="col">Views</th></tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="accounts-title">
          <h2 class="page-subtitle" id="accounts-title">Accounts</h2>
          <form class="search" id="search" role="search">
            <label class="sr-only" for="q">Search accounts</label>
            <input id="q" type="search" placeholder="Email or GitHub login" />
            <button class="btn" type="submit">Search</button>
          </form>
          <div class="table-wrap">
            <table class="table" id="accounts">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Plan</th>
                  <th scope="col">Machines</th>
                  <th scope="col">Tunnels</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Last seen</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <button class="btn btn-quiet" id="more" type="button" hidden>Load more</button>
        </section>
      </div>
    </main>

    <footer class="footer">
      <div class="wrap footer-row">
        <nav class="footer-links" aria-label="Footer">
          <a href="https://github.com/dilyorm/tunnel-ai">GitHub</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <a href="/refund">Refunds</a>
          <a href="https://dilyor.dev">dilyor.dev</a>
        </nav>
      </div>
    </footer>

    <script type="module" src="/src/admin.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `site/src/admin.ts`**

```ts
import './style.css';
import './app.css';
import { lineChart, type Line } from './chart';
import { ApiError, accountLink, api, beacon, button, byId, formatDay, messageOf, say, title } from './page';

// The relay owner's page: today's numbers, who is active, plans and revenue, 30-day charts,
// referrers, and the accounts table with plan grants. The API answers 404 to everyone else.

type Plan = 'free' | 'plus' | 'pro';
type Windows = { d1: number; d7: number; d30: number };

interface Stats {
  days: string[];
  series: Record<string, number[]>;
  today: Record<string, number>;
  active: { agents: Windows; devices: Windows; accounts: Windows };
  plans: Record<Plan, number>;
  mrr: number;
  referrers: { host: string; n: number }[];
}

interface AdminAccount {
  id: string;
  email: string;
  githubLogin: string | null;
  plan: Plan;
  planSource: 'billing' | 'admin' | null;
  planUntil: number | null;
  created: number;
  seen: number;
  devices: number;
  tunnels: number;
}

type Grant = Pick<AdminAccount, 'plan' | 'planSource' | 'planUntil'>;

const INK = 'var(--ink)';
const SIGNAL = 'var(--signal)';
const STONE = 'var(--stone)';

function cell(content: string | Node) {
  const td = document.createElement('td');
  td.append(content);
  return td;
}

function numbers(target: HTMLElement, items: [label: string, value: number | string][]) {
  target.replaceChildren(
    ...items.map(([label, value]) => {
      const item = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = typeof value === 'number' ? value.toLocaleString() : value;
      item.append(dt, dd);
      return item;
    }),
  );
}

function showStats(stats: Stats) {
  const t = stats.today;
  numbers(byId('today'), [
    ['Messages', t.messages],
    ['Tunnels opened', t.tunnels_opened],
    ['Installs', t.installs_sh + t.installs_ps1 + t.installs_npm],
    ['Page views', t.page_views],
    ['Visitors', t.unique_visitors],
    ['Sign-ups', t.signups],
    ['Active agents', stats.active.agents.d1],
  ]);

  const active: [string, Windows][] = [
    ['Agents', stats.active.agents],
    ['Machines', stats.active.devices],
    ['Accounts', stats.active.accounts],
  ];
  byId<HTMLTableElement>('active').tBodies[0].replaceChildren(
    ...active.map(([label, w]) => {
      const row = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      row.append(th, cell(w.d1.toLocaleString()), cell(w.d7.toLocaleString()), cell(w.d30.toLocaleString()));
      return row;
    }),
  );

  numbers(byId('plans'), [
    ['Free', stats.plans.free],
    ['Plus', stats.plans.plus],
    ['Pro', stats.plans.pro],
    ['Revenue', `$${stats.mrr.toLocaleString()} a month`],
  ]);

  const s = stats.series;
  const charts: [string, Line[]][] = [
    ['Messages', [{ label: 'Messages', values: s.messages, color: INK }]],
    [
      'Installs',
      [
        { label: 'install.sh', values: s.installs_sh, color: INK },
        { label: 'install.ps1', values: s.installs_ps1, color: SIGNAL },
        { label: 'npm', values: s.installs_npm, color: STONE },
      ],
    ],
    [
      'Active',
      [
        { label: 'Agents', values: s.active_members, color: INK },
        { label: 'Machines', values: s.active_devices, color: SIGNAL },
      ],
    ],
    [
      'Landing page',
      [
        { label: 'Views', values: s.page_views, color: INK },
        { label: 'Visitors', values: s.unique_visitors, color: SIGNAL },
      ],
    ],
    ['Sign-ups', [{ label: 'Sign-ups', values: s.signups, color: INK }]],
  ];
  byId('charts').replaceChildren(...charts.map(([name, lines]) => lineChart(name, stats.days, lines)));

  const referrers = byId<HTMLTableElement>('referrers');
  referrers.tBodies[0].replaceChildren(
    ...stats.referrers.map((r) => {
      const row = document.createElement('tr');
      row.append(cell(r.host), cell(r.n.toLocaleString()));
      return row;
    }),
  );
  referrers.hidden = stats.referrers.length === 0;
  byId('no-referrers').hidden = stats.referrers.length > 0;
}

// ---------- accounts ----------

function grantPath(account: AdminAccount) {
  return `/v1/admin/accounts/${encodeURIComponent(account.id)}/plan`;
}

function planControl(account: AdminAccount, saved: (account: AdminAccount) => void) {
  const box = document.createElement('div');
  box.className = 'grant';

  const select = document.createElement('select');
  select.setAttribute('aria-label', `Plan for ${account.email}`);
  for (const plan of ['free', 'plus', 'pro'] as const) {
    select.append(new Option(title(plan), plan, false, plan === account.plan));
  }
  const until = document.createElement('input');
  until.type = 'date';
  until.setAttribute('aria-label', `Last day of the plan for ${account.email} (optional)`);
  if (account.planUntil) until.value = new Date(account.planUntil).toISOString().slice(0, 10);

  box.append(
    select,
    until,
    button('Save', async () => {
      const grant = await api<Grant>('POST', grantPath(account), {
        plan: select.value,
        // The plan runs to the end of the chosen day (UTC).
        until: until.value ? Date.parse(`${until.value}T23:59:59Z`) : null,
      });
      saved({ ...account, ...grant });
      say(`${account.email} is on ${title(grant.plan)}${grant.planUntil ? ` until ${formatDay(grant.planUntil)}` : ''}.`);
    }),
  );
  if (account.planSource === 'admin') {
    box.append(
      button(
        'Clear',
        async () => {
          const grant = await api<Grant>('POST', grantPath(account), { plan: null });
          saved({ ...account, ...grant });
          say(`Cleared the grant for ${account.email}. The account is on ${title(grant.plan)}.`);
        },
        true,
      ),
    );
  }
  const source = document.createElement('span');
  source.className = 'muted';
  source.textContent = account.planSource === 'admin' ? 'granted' : account.planSource === 'billing' ? 'paid' : '';
  box.append(source);
  return box;
}

function accountRow(account: AdminAccount): HTMLTableRowElement {
  const row = document.createElement('tr');
  const who = cell(account.email);
  if (account.githubLogin) {
    const login = document.createElement('span');
    login.className = 'muted';
    login.textContent = ` @${account.githubLogin}`;
    who.append(login);
  }
  row.append(
    who,
    cell(planControl(account, (updated) => row.replaceWith(accountRow(updated)))),
    cell(account.devices.toLocaleString()),
    cell(account.tunnels.toLocaleString()),
    cell(formatDay(account.created)),
    cell(formatDay(account.seen)),
  );
  return row;
}

let query = '';
let next: string | null = null;

async function loadAccounts(fromStart: boolean) {
  const search = new URLSearchParams({ q: query });
  if (!fromStart && next) search.set('cursor', next);
  const page = await api<{ accounts: AdminAccount[]; next: string | null }>('GET', `/v1/admin/accounts?${search}`);
  const body = byId<HTMLTableElement>('accounts').tBodies[0];
  const rows = page.accounts.map(accountRow);
  if (fromStart && rows.length === 0) {
    const row = document.createElement('tr');
    const empty = cell(query ? `No accounts match "${query}".` : 'No accounts yet.');
    empty.colSpan = 6;
    row.append(empty);
    rows.push(row);
  }
  if (fromStart) body.replaceChildren(...rows);
  else body.append(...rows);
  next = page.next;
  byId('more').hidden = !next;
}

byId<HTMLFormElement>('search').addEventListener('submit', (event) => {
  event.preventDefault();
  query = byId<HTMLInputElement>('q').value.trim();
  loadAccounts(true).catch((error) => say(messageOf(error), 'error'));
});

byId('more').addEventListener('click', () => {
  loadAccounts(false).catch((error) => say(messageOf(error), 'error'));
});

// ---------- start ----------

async function main() {
  accountLink();
  beacon();
  let stats: Stats;
  try {
    stats = await api<Stats>('GET', '/v1/admin/stats?days=30');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) byId('denied').hidden = false;
    else say(messageOf(error), 'error');
    return;
  }
  byId('admin').hidden = false;
  showStats(stats);
  await loadAccounts(true).catch((error) => say(messageOf(error), 'error'));
}

main();
```

- [ ] **Step 5: Style it, in `site/src/app.css`**

Append:

```css
/* ---------- admin ---------- */

.numbers {
  margin: 16px 0 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 20px 24px;
}

.numbers dt {
  color: var(--stone);
  font-size: 0.875rem;
}

.numbers dd {
  margin: 4px 0 0;
  font: 400 2rem/1.1 var(--pixel);
}

.charts {
  margin-top: 16px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
  gap: 40px 48px;
}

.chart {
  margin: 0;
}

.chart figcaption {
  font-weight: 500;
}

.chart svg {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 8px;
  overflow: visible;
}

.chart-grid {
  stroke: var(--rule);
}

.chart-axis {
  stroke: var(--ink);
}

.chart-line {
  fill: none;
  stroke-width: 2;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.chart-label {
  fill: var(--stone);
  font: 400 11px var(--sans);
}

.chart-legend {
  list-style: none;
  margin-top: 8px;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  font-size: 0.875rem;
  color: var(--stone);
}

.chart-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 6px;
  vertical-align: -1px;
}

.search {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
  max-width: 32rem;
}

.search .btn,
#more {
  margin-top: 0;
}

#more {
  margin-top: 16px;
}

.grant {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.grant select,
.grant input {
  padding: 6px 8px;
  border: 1px solid var(--rule);
  background: var(--paper);
  color: var(--ink);
  font: 400 0.875rem var(--sans);
}

.muted {
  color: var(--stone);
  font-size: 0.875rem;
}
```

- [ ] **Step 6: Add the page to the build, in `site/vite.config.ts`**

```ts
const PAGES = ['index', 'terms', 'privacy', 'refund', 'account', 'admin'];
```

- [ ] **Step 7: Run the check**

Run: `cd site && npm run build && npm run check`
Expected: `Site check passed: 6 pages.`

- [ ] **Step 8: Try it in a browser**

Start `dev-relay` and `site` from `.claude/launch.json`. Make some activity first, in Git Bash from `cli/`:

```bash
export TUNNEL_HOME="$(mktemp -d)" TUNNEL_RELAY=http://127.0.0.1:8787
npx tsx src/bin.ts open admin-check && npx tsx src/bin.ts send "hello"
```

Load `http://localhost:5173/` once (a page view), then sign in at `/account` as `dev@example.com` (the link is in the dev relay's log) and click Admin.

1. Today shows Messages 1, Tunnels opened 1, Page views at least 1, Active agents 1. Active shows Agents 1 and Machines 1 in all three columns.
2. Plans shows Free with the dev account counted, and Revenue `$0 a month` (or `$5` if you bought Plus in Task 11).
3. Five charts render with day labels at both ends and a legend; the Messages line ends at 1.
4. Accounts lists `dev@example.com`. Search for `nobody`: "No accounts match "nobody"." Clear the search and Search again.
5. Give `dev@example.com` Pro with a date next week, Save: the status says so, and the row's control shows Pro, the date, Clear and "granted". `/account` shows Plan `Pro until <date>`. Clear: back to what billing says.
6. Sign out, sign in as `other@example.com`, open `/admin`: only "This page is for the relay's admins. Go to your account."
7. At 375 px wide the charts stack, and only the tables scroll sideways inside their boxes.

- [ ] **Step 9: Commit**

```bash
git add site/src/chart.ts site/admin.html site/src/admin.ts site/src/app.css site/vite.config.ts site/scripts/check.mjs
git commit -m "feat(site): admin page with daily charts, active users, plans and grants" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Deploy files, docs, and going live

**Files:**
- Modify: `deploy/tunnel-relay.service`
- Create: `deploy/tunnel-relay.env.example`
- Modify: `deploy/nginx.conf`
- Modify: `deploy/deploy.sh` (the site step runs the check)
- Modify: `README.md`, then copy it to `cli/README.md` (the two are identical today)

**Interfaces:**
- Consumes: the variable names in `relay/config.ts` (Task 2); `GET /internal/install?f=` and `installMetric` (Task 4), which counts `/install.sh`, `/install.ps1` and `/tunnel-ai[-version].tgz` fetched by npm; the site pages from Tasks 10–12; `npm run check` (Task 10); `npm run dev-relay` (Task 11).
- Produces: `/etc/tunnel-relay.env` on the server, root-owned, mode 600, read by systemd before it drops to the dynamic user. Without the file the relay runs as a plain mailbox.

Part A changes files and ends in a commit. Part B touches the live server and **starts only after the user says yes in chat**.

#### Part A: files

- [ ] **Step 1: Write the failing check**

There is no nginx or systemd on the Windows machine, so this step checks the files for the changes this task makes. Run it from the repo root in Git Bash:

```bash
fail=0
check() { grep -qF -- "$2" "$1" || { echo "missing in $1: $2"; fail=1; }; }
check deploy/tunnel-relay.service 'EnvironmentFile=-/etc/tunnel-relay.env'
check deploy/nginx.conf 'try_files $uri $uri.html $uri/ =404;'
check deploy/nginx.conf 'mirror /_count;'
check deploy/nginx.conf 'client_max_body_size 101m;'
check deploy/deploy.sh 'npm run build && npm run check'
for v in TUNNEL_PUBLIC_URL GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET RESEND_API_KEY TUNNEL_EMAIL_FROM \
  LEMONSQUEEZY_API_KEY LEMONSQUEEZY_STORE_ID LEMONSQUEEZY_WEBHOOK_SECRET LEMONSQUEEZY_VARIANT_PLUS \
  LEMONSQUEEZY_VARIANT_PRO TUNNEL_ADMIN_EMAILS TUNNEL_STATS_SALT; do
  grep -q "^$v=" deploy/tunnel-relay.env.example 2>/dev/null || { echo "missing in env example: $v"; fail=1; }
done
check README.md '## Plans'
cmp -s README.md cli/README.md || { echo "cli/README.md differs from README.md"; fail=1; }
[ "$fail" = 0 ] && echo "deploy files OK"
```

- [ ] **Step 2: Run it to see it fail**

Expected: a `missing in …` line for every `check` and for all 12 variables (the example file doesn't exist yet), and no `deploy files OK`. The README copy check passes for now; the two files are identical until Step 7.

- [ ] **Step 3: Load the settings file from systemd, in `deploy/tunnel-relay.service`**

Replace

```ini
# nginx overwrites X-Forwarded-For with the real client address.
Environment=TUNNEL_TRUST_PROXY=1
```

with

```ini
# nginx overwrites X-Forwarded-For with the real client address.
Environment=TUNNEL_TRUST_PROXY=1
# Accounts, sign-in, billing and admin, secrets included. Root-owned, mode 600; systemd reads it
# before dropping privileges. Optional: without it the relay is a plain mailbox.
# deploy/tunnel-relay.env.example lists the variables.
EnvironmentFile=-/etc/tunnel-relay.env
```

- [ ] **Step 4: Create `deploy/tunnel-relay.env.example`**

```bash
# /etc/tunnel-relay.env: the hosted relay's settings that hold secrets.
# Fill in a copy OUTSIDE the repo, then on the server:
#   sudo install -m 600 -o root -g root tunnel-relay.env /etc/tunnel-relay.env
#   sudo systemctl restart tunnel-relay
# A feature stays off until all of its variables are set, and the relay logs which ones are missing.

# The site's origin. Accounts, sign-in, billing and admin all need it.
TUNNEL_PUBLIC_URL=https://tunnel.dilyor.dev

# GitHub sign-in: github.com/settings/developers, New OAuth App.
# Homepage https://tunnel.dilyor.dev, callback https://tunnel.dilyor.dev/v1/auth/github/callback
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Email sign-in through Resend. The sender's domain must be verified in Resend first.
RESEND_API_KEY=
TUNNEL_EMAIL_FROM="tunnel <login@tunnel.dilyor.dev>"

# Billing through Lemon Squeezy. Start in test mode; live mode has its own key, variants and webhook.
# Webhook: https://tunnel.dilyor.dev/v1/billing/webhook, with the events subscription_created,
# subscription_updated, subscription_cancelled, subscription_resumed, subscription_expired,
# subscription_paused and subscription_unpaused.
LEMONSQUEEZY_API_KEY=
LEMONSQUEEZY_STORE_ID=
LEMONSQUEEZY_WEBHOOK_SECRET=
# Variant ids of the $5 a month Plus and $9 a month Pro subscriptions.
LEMONSQUEEZY_VARIANT_PLUS=
LEMONSQUEEZY_VARIANT_PRO=

# Comma-separated emails that can open /admin. Setting it also turns on the stats.
TUNNEL_ADMIN_EMAILS=
# Key for the daily visitor hashes. Make one with: openssl rand -hex 32
TUNNEL_STATS_SALT=
```

- [ ] **Step 5: Rewrite `deploy/nginx.conf`**

Clean URLs for the new pages, install counting, and room for 100 MB files:

```nginx
# /etc/nginx/sites-available/tunnel.dilyor.dev
# Site from /var/www/tunnel-ai, relay API under /v1/.
# Certbot rewrites this file in place to add the TLS block and the :80 redirect. deploy.sh installs
# it only when the server has none, so later changes here are copied into the live file by hand.

server {
    listen 80;
    listen [::]:80;
    server_name tunnel.dilyor.dev;

    root /var/www/tunnel-ai;
    index index.html;

    # /account serves account.html, /terms serves terms.html, and so on.
    location / {
        try_files $uri $uri.html $uri/ =404;
    }

    # Vite fingerprints everything under /assets/, so it can be cached forever.
    location /assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Install scripts read as text in a browser; they and the package must never be stale.
    # Each download is also mirrored to the relay's install counter.
    location ~ ^/install\.(sh|ps1)$ {
        types { }
        default_type text/plain;
        charset utf-8;
        add_header Cache-Control "no-cache";
        mirror /_count;
        mirror_request_body off;
    }

    location ~ ^/tunnel-ai(-[\w.-]+)?\.tgz$ {
        add_header Cache-Control "no-cache";
        mirror /_count;
        mirror_request_body off;
    }

    # The counter answers on loopback only and lives outside /v1/, so the public can't reach it.
    location = /_count {
        internal;
        proxy_pass http://127.0.0.1:8797/internal/install?f=$request_uri;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header User-Agent $http_user_agent;
        # Overwrite, never append, as in /v1/: the relay rate-limits by this header.
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    location /v1/ {
        proxy_pass http://127.0.0.1:8797;
        proxy_http_version 1.1;
        proxy_set_header Host            $host;
        proxy_set_header Connection      "";
        # Overwrite, never append: the relay rate-limits by the first entry.
        proxy_set_header X-Forwarded-For $remote_addr;

        # `tunnel wait` long-polls for up to 55 s.
        proxy_buffering         off;
        proxy_request_buffering off;
        proxy_read_timeout      90s;
        proxy_send_timeout      90s;

        # Pro files are capped at 100 MB by the relay; the extra megabyte is encryption overhead.
        client_max_body_size 101m;
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
```

- [ ] **Step 6: Run the site check before every deploy, in `deploy/deploy.sh`**

Replace

```bash
  (cd "$ROOT/site" && npm run build)
```

with

```bash
  (cd "$ROOT/site" && npm run build && npm run check)
```

- [ ] **Step 7: Document plans and self-hosted settings, in `README.md`**

After the `## Teach your agents` section (before `## How it works`), add:

````markdown
## Plans

The hosted relay is free without an account. Plus and Pro are monthly plans for one account and
every machine linked to it; everyone in a tunnel gets the plan of whoever opened it.

| | Free | Plus, $5 a month | Pro, $9 a month |
|---|---|---|---|
| Tunnels | 1 per machine | 10 | 20 |
| Files | up to 10 MB | up to 50 MB | up to 100 MB |
| History | 7 days | 30 days | 30 days |
| File storage | | 2 GB | 5 GB |

```bash
tunnel login      # link this machine to your account (opens a browser)
tunnel account    # your plan, limits and usage
tunnel upgrade    # pay for Plus or Pro
tunnel logout     # unlink this machine
```

Payments go through Lemon Squeezy. Manage or cancel a plan at https://tunnel.dilyor.dev/account.
````

In `## How it works`, replace

```markdown
- Messages wait in the tunnel's mailbox (7 days), because agents work in turns.
```

with

```markdown
- Messages wait in the tunnel's mailbox (7 days on Free, 30 on Plus and Pro), because agents
  work in turns.
```

At the end of `## Run your own relay` (after the paragraph ending "behind the hosted relay."), add:

```markdown
### Accounts and billing on your relay

A relay with none of these set is a plain mailbox, and every machine gets the Free limits
(`TUNNEL_MAX_TUNNELS` sets the Free cap per machine; 0 or unset means no cap).

- `TUNNEL_PUBLIC_URL`, the site's origin, turns on accounts.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` add GitHub sign-in.
- `RESEND_API_KEY` and `TUNNEL_EMAIL_FROM` add email sign-in.
- The five `LEMONSQUEEZY_*` variables add Plus and Pro billing.
- `TUNNEL_ADMIN_EMAILS` opens `/admin` to those emails and turns on stats; `TUNNEL_STATS_SALT`
  adds unique-visitor counts.

`deploy/tunnel-relay.env.example` explains each one. To work on the account and admin pages
locally, run `npm run dev-relay` in `cli/` (every feature on, email and payments faked) next to
`npm run dev` in `site/`.
```

In the `## Repo` table, replace the `deploy/` row with:

```markdown
| `deploy/` | systemd unit, settings example, nginx vhost, deploy script for the hosted relay |
```

Then make the package README match:

```bash
cp README.md cli/README.md
```

- [ ] **Step 8: Run the check, the tests and the builds**

Run the Step 1 check again. Expected: `deploy files OK`.

Run: `cd cli && npm test && npm run typecheck && cd ../site && npm run build && npm run check`
Expected: `# fail 0`, no type errors, `Site check passed: 6 pages.`

- [ ] **Step 9: Commit**

```bash
git add deploy/tunnel-relay.service deploy/tunnel-relay.env.example deploy/nginx.conf deploy/deploy.sh README.md cli/README.md
git commit -m "chore(deploy): settings file, clean page URLs, install counting, 100 MB uploads; document plans" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

#### Part B: going live (ask first)

- [ ] **Step 10: Ask the user before touching the server**

Nothing below runs until the user answers yes in chat. Ask:

> Everything is committed locally and nothing is pushed. Going live means: back up the relay's data, install your settings file, deploy the relay and site, and edit the live nginx file (I'll show you the diff first). The relay restarts once, for a few seconds. Go ahead?

These have to be done by the owner beforehand, outside the chat. Secret values go only into a local file outside the repo (for example `~/tunnel-relay.env`, copied from `deploy/tunnel-relay.env.example`), never into the chat or a command line:

1. Resend: verify the domain `tunnel.dilyor.dev` (its DNS records) and create an API key.
2. GitHub: create an OAuth app with the homepage and callback URLs from the example file.
3. Lemon Squeezy, in test mode: a store, a "tunnel Plus" subscription product at $5 a month and a "tunnel Pro" one at $9 a month, a webhook with the URL and events from the example file, and an API key. Put the two variant ids in the file.
4. `TUNNEL_ADMIN_EMAILS` set to the owner's email, and `TUNNEL_STATS_SALT` from `openssl rand -hex 32`.
5. A mailbox that receives `tunnel@dilyor.dev`, the contact address on the legal pages.

- [ ] **Step 11: Back up the relay's data**

```bash
ssh oraclewps 'sudo systemctl stop tunnel-relay && sudo tar -C /var/lib/private -czf ~/tunnel-relay-backup-$(date +%F).tgz tunnel-relay; sudo systemctl start tunnel-relay'
ssh oraclewps 'ls -l ~/tunnel-relay-backup-*.tgz'
```

Expected: a backup file a few MB or smaller. (The relay starts again even if `tar` fails.)

- [ ] **Step 12: Install the settings file without reading it**

Copy the owner's file as-is. Never `cat` it or print values; the last command prints only the variable names, and then the ones still empty.

```bash
scp ~/tunnel-relay.env oraclewps:/tmp/tunnel-relay.env
ssh oraclewps 'sudo install -m 600 -o root -g root /tmp/tunnel-relay.env /etc/tunnel-relay.env && rm /tmp/tunnel-relay.env'
ssh oraclewps 'sudo grep -o "^[A-Z_]*=" /etc/tunnel-relay.env; echo "empty:"; sudo grep -oE "^[A-Z_]+=$" /etc/tunnel-relay.env'
```

Expected: all 12 names, and nothing under `empty:`. If something is empty, stop and tell the owner which name.

- [ ] **Step 13: Deploy the relay and the site**

```bash
deploy/deploy.sh
```

Expected: `site deployed`, the health JSON, `relay deployed`. Then:

```bash
ssh oraclewps 'sudo journalctl -u tunnel-relay -n 40 --no-pager'
```

Expected: no line containing `is off` (each one names a missing variable).

- [ ] **Step 14: Edit the live nginx file, showing the diff first**

Certbot owns the live file, so apply this task's nginx changes to it by hand instead of replacing it:

```bash
ssh oraclewps 'sudo cp /etc/nginx/sites-available/tunnel.dilyor.dev /etc/nginx/tunnel.dilyor.dev.bak-$(date +%F)'
scp oraclewps:/etc/nginx/sites-available/tunnel.dilyor.dev "$SCRATCH/live.conf"
cp "$SCRATCH/live.conf" "$SCRATCH/live.new.conf"
```

(`$SCRATCH` is the session's scratchpad directory. The backup sits outside `sites-enabled/`, so nginx never loads it.)

In `live.new.conf`, inside the `server` block that serves the site (the one with `listen 443 ssl`), make the same five changes as Step 5 and touch nothing certbot wrote:

1. `try_files $uri $uri/ =404;` becomes `try_files $uri $uri.html $uri/ =404;`.
2. The install-script location gets `mirror /_count;` and `mirror_request_body off;`.
3. `location = /tunnel-ai.tgz { … }` becomes the `location ~ ^/tunnel-ai(-[\w.-]+)?\.tgz$ { … }` block.
4. The `location = /_count { … }` block is added before `location /v1/`.
5. `client_max_body_size 11m;` becomes `client_max_body_size 101m;`, with the new comment.

Show the user `diff -u "$SCRATCH/live.conf" "$SCRATCH/live.new.conf"` and wait for a yes. Then:

```bash
scp "$SCRATCH/live.new.conf" oraclewps:/tmp/tunnel.nginx.conf
ssh oraclewps 'sudo install -m 644 /tmp/tunnel.nginx.conf /etc/nginx/sites-available/tunnel.dilyor.dev && rm /tmp/tunnel.nginx.conf
  if sudo nginx -t; then sudo systemctl reload nginx && echo "nginx reloaded"
  else sudo cp /etc/nginx/tunnel.dilyor.dev.bak-$(date +%F) /etc/nginx/sites-available/tunnel.dilyor.dev; echo "nginx -t failed, old file restored"; exit 1; fi'
```

Expected: `nginx reloaded`.

- [ ] **Step 15: Smoke checks**

```bash
curl -fsS https://tunnel.dilyor.dev/v1/health
curl -fsS https://tunnel.dilyor.dev/v1/auth/methods
curl -sI https://tunnel.dilyor.dev/account | head -1
curl -sI https://tunnel.dilyor.dev/terms | head -1
curl -fsS https://tunnel.dilyor.dev/robots.txt
curl -fsS https://tunnel.dilyor.dev/sitemap.xml
curl -fsS -o /dev/null https://tunnel.dilyor.dev/install.sh && echo "install.sh fetched"
```

Expected: `{"ok":true,…}`; `{"github":true,"email":true,"billing":true}`; `HTTP/2 200` twice; robots with `Disallow: /account` and `Disallow: /admin`; a sitemap with the landing page and the three legal pages; `install.sh fetched` (it counts as one install today; Step 16 checks that).

Then a real tunnel against the hosted relay, from `cli/` in Git Bash:

```bash
export TUNNEL_HOME="$(mktemp -d)"
npx tsx src/bin.ts open deploy-check && npx tsx src/bin.ts send "deploy check" && npx tsx src/bin.ts close
```

Expected: `Tunnel deploy-check is open…`, the message sends, and `Closed deploy-check. Its messages and files were deleted from the relay.`

- [ ] **Step 16: Hand the browser checks to the owner**

Tell the user these need them, in their own browser:

1. Sign in at https://tunnel.dilyor.dev/account with email, then sign out and sign in with GitHub.
2. Open https://tunnel.dilyor.dev/admin. Today shows at least 1 install (Step 15's `install.sh`), 1 message and 1 tunnel opened.
3. Get Plus with a Lemon Squeezy **test card** (the owner types it; Claude never enters card numbers). The account page shows Plus within a minute; Manage billing opens Lemon Squeezy's portal; cancelling there shows "Plus, ends <date>".
4. Run `tunnel login` on a machine and confirm the code on the account page.

Once the owner has read and corrected the legal pages, they submit the Lemon Squeezy store for activation (it asks for the Terms, Privacy and Refund URLs). If the store isn't approved, the fallback is Paddle, one new adapter next to `billing/lemonsqueezy.ts`. Going live then means a new API key, the live variant ids and the live webhook secret in `/etc/tunnel-relay.env` (Step 12 again), then `sudo systemctl restart tunnel-relay`.
