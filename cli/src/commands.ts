import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';
import { formatCode, parseCode, randomSecret } from './codes.js';
import { b64, deriveInviteKeys, newKey, open, openText, seal, sealText, sha256, unb64 } from './crypto.js';
import { TunnelError, UsageError } from './errors.js';
import {
  formatSize,
  isForMe,
  MAX_TEXT_BYTES,
  nameMatches,
  openMessage,
  renderLine,
  renderMessage,
  sealMessage,
  type FileRef,
  type Plain,
  type Received,
} from './messages.js';
import { RelayClient } from './relay-client.js';
import { formatBytes, PLANS } from './relay/plans.js';
import { Store, type TunnelRecord } from './store.js';

export const DEFAULT_RELAY = 'https://tunnel.dilyor.dev';
const LONG_POLL_S = 50;
/**
 * How long `tunnel wait` blocks by default. It stays under the 2-minute command limit of
 * Claude Code and OpenCode, and Gemini CLI's 300 s silence limit.
 */
export const WAIT_DEFAULT_S = 90;

export interface IO {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  out(line: string): void;
  err(line: string): void;
  signal?: AbortSignal;
  stdin?: () => Promise<string>;
  /** Open a link in the person's browser. bin.ts only does this on a terminal. */
  openUrl?(url: string): void;
}

export interface Flags {
  relay?: string;
  tunnel?: string;
  json?: boolean;
  as?: string;
  to?: string;
  file?: string[];
  timeout?: string;
  out?: string;
  port?: string;
  host?: string;
  data?: string;
  claude?: boolean;
  codex?: boolean;
  agent?: string[];
  all?: boolean;
  refresh?: boolean;
  force?: boolean;
}

export interface Ctx extends IO {
  cwd: string;
  flags: Flags;
  store: Store;
}

// ---------- shared helpers ----------

const trimSlash = (url: string) => url.replace(/\/+$/, '');

export function relayFor(ctx: Ctx): string {
  return trimSlash(ctx.flags.relay || ctx.env.TUNNEL_RELAY || ctx.store.config().relay || DEFAULT_RELAY);
}

async function deviceToken(ctx: Ctx, relay: string): Promise<string> {
  const config = ctx.store.config();
  const known = config.devices[relay];
  if (known) return known.token;
  const created = await new RelayClient(relay).json<{ deviceId: string; deviceToken: string }>('POST', '/v1/devices');
  config.devices[relay] = { id: created.deviceId, token: created.deviceToken };
  ctx.store.saveConfig(config);
  return created.deviceToken;
}

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

/** Variables coding agents set in the shells they run, checked in order after Claude Code and Codex. Kilo also sets OPENCODE. */
const AGENT_ENV: [variable: string, name: string][] = [
  ['KILO_PID', 'kilo'],
  ['OPENCODE', 'opencode'],
  ['GEMINI_CLI', 'gemini'],
  ['CURSOR_AGENT', 'cursor'],
  ['COPILOT_CLI', 'copilot'],
  ['GOOSE_TERMINAL', 'goose'],
  ['CRUSH', 'crush'],
  ['QWEN_CODE', 'qwen'],
  ['PI_CODING_AGENT', 'pi'],
];

/** The default name for this agent, guessed from its shell's environment. Only a default, never used for security. */
export function agentKind(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDECODE) return 'claude';
  if (Object.keys(env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  for (const [variable, name] of AGENT_ENV) if (env[variable]) return name;
  const named = env.AI_AGENT?.toLowerCase();
  if (named && /^[a-z][a-z0-9-]{0,31}$/.test(named)) return named;
  try {
    return userInfo().username.toLowerCase() || 'agent';
  } catch {
    return 'agent';
  }
}

function memberName(ctx: Ctx): string {
  const raw = (ctx.flags.as ?? ctx.env.TUNNEL_AS ?? agentKind(ctx.env)).trim();
  const host = hostname().split('.')[0].toLowerCase() || 'host';
  const name = raw.includes('@') ? raw : `${raw}@${host}`;
  if (!/^[\w.@-]{1,64}$/.test(name)) {
    throw new UsageError(`"${name}" can't be used as a name. Use letters, digits, ".", "-", "_" and "@".`);
  }
  return name;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
}

const keyOf = (rec: TunnelRecord) => unb64(rec.key);
const api = (rec: TunnelRecord) => new RelayClient(rec.relay, rec.memberToken);
const tunnelPath = (rec: TunnelRecord, rest = '') => `/v1/tunnels/${rec.id}${rest}`;

function joinHint(rec: TunnelRecord, code: string) {
  return `tunnel join ${code}` + (rec.relay === DEFAULT_RELAY ? '' : ` --relay ${rec.relay}`);
}

interface Peer {
  id: string;
  name: string;
  seen: number;
  you: boolean;
  owner: boolean;
}

async function peers(rec: TunnelRecord): Promise<Peer[]> {
  const res = await api(rec).json<{
    members: { id: string; profile: string | null; seen: number; you: boolean; owner: boolean }[];
  }>('GET', tunnelPath(rec, '/members'));
  const key = keyOf(rec);
  return res.members.map((m) => {
    let name = '(joining)';
    if (m.profile) {
      try {
        name = (JSON.parse(openText(key, m.profile)) as { name: string }).name;
      } catch {
        name = '(unreadable)';
      }
    }
    return { id: m.id, name, seen: m.seen, you: m.you, owner: m.owner };
  });
}

async function createInvite(rec: TunnelRecord) {
  const secret = randomSecret();
  const salt = randomBytes(16);
  const { wrapKey, verifier } = deriveInviteKeys(secret, salt);
  const payload = JSON.stringify({ v: 1, tunnelId: rec.id, name: rec.name, key: rec.key });
  const res = await api(rec).json<{ slot: number; expiresAt: number }>('POST', tunnelPath(rec, '/invites'), {
    salt: b64(salt),
    wrapped: b64(seal(wrapKey, Buffer.from(payload, 'utf8'))),
    verifierHash: sha256(verifier),
  });
  return { code: formatCode(res.slot, secret), expiresAt: res.expiresAt };
}

function printInvite(ctx: Ctx, rec: TunnelRecord, code: string) {
  ctx.out(`Invite code: ${code}`);
  ctx.out('Works once. Expires in 15 minutes.');
  ctx.out(`On the other machine: ${joinHint(rec, code)}`);
}

/** Fetch messages after the cursor. Undecryptable messages are skipped. */
async function fetchAfter(ctx: Ctx, rec: TunnelRecord, after: number, waitS: number) {
  const res = await api(rec).json<{ messages: { seq: number; from: string; ct: string }[]; latest: number }>(
    'GET',
    tunnelPath(rec, `/messages?after=${after}&wait=${waitS}&limit=200`),
    undefined,
    { timeoutMs: (waitS + 20) * 1000, signal: ctx.signal },
  );
  const key = keyOf(rec);
  const messages: Received[] = [];
  for (const raw of res.messages) {
    const plain = openMessage(key, raw.ct);
    if (!plain) {
      ctx.err(`Skipped message #${raw.seq}: it could not be decrypted with this tunnel's key.`);
      continue;
    }
    messages.push({ ...plain, seq: raw.seq, memberId: raw.from, mine: raw.from === rec.memberId });
  }
  const last = res.messages.at(-1)?.seq ?? after;
  return { messages, last, full: res.messages.length === 200 };
}

function remember(rec: TunnelRecord, messages: Received[]) {
  for (const m of messages) for (const f of m.files) rec.files[f.id] = { name: f.name, size: f.size };
}

function print(ctx: Ctx, rec: TunnelRecord, messages: Received[]) {
  messages.forEach((m, i) => {
    if (ctx.flags.json) ctx.out(JSON.stringify({ tunnel: rec.name, ...m }));
    else ctx.out((i > 0 ? '\n' : '') + renderMessage(m, rec.name));
  });
}

function seconds(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout must be a number of seconds, got "${value}".`);
  return n;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

// ---------- commands ----------

export async function openCmd(ctx: Ctx, args: string[]) {
  const name = ctx.store.uniqueName(slug(args[0] ?? basename(ctx.cwd)) || 'tunnel');
  const relay = relayFor(ctx);
  const me = memberName(ctx);
  const key = newKey();
  const res = await withDevice(ctx, relay, (client) =>
    client.json<{ tunnelId: string; memberId: string; memberToken: string }>('POST', '/v1/tunnels', {
      profile: sealText(key, JSON.stringify({ name: me })),
    }),
  );
  const rec: TunnelRecord = {
    name,
    id: res.tunnelId,
    relay,
    key: b64(key),
    memberId: res.memberId,
    memberToken: res.memberToken,
    me,
    cursor: 0,
    files: {},
  };
  ctx.store.saveTunnel(rec);
  ctx.store.setCurrent(name);
  const invite = await createInvite(rec);
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ tunnel: name, me, code: invite.code, expiresAt: invite.expiresAt, join: joinHint(rec, invite.code) }));
    return;
  }
  ctx.out(`Tunnel ${name} is open. You are ${me}.`);
  printInvite(ctx, rec, invite.code);
}

export async function inviteCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  const invite = await createInvite(rec);
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ tunnel: rec.name, code: invite.code, expiresAt: invite.expiresAt, join: joinHint(rec, invite.code) }));
    return;
  }
  printInvite(ctx, rec, invite.code);
}

export async function joinCmd(ctx: Ctx, args: string[]) {
  if (!args.length) throw new UsageError('Usage: tunnel join <code>   e.g. tunnel join 7-orange-fox-tide');
  const { slot, secret } = parseCode(args.join('-'));
  const relay = relayFor(ctx);
  const me = memberName(ctx);
  const anon = new RelayClient(relay);
  const { salt } = await anon.json<{ salt: string }>('GET', `/v1/invites/${slot}`);
  const { wrapKey, verifier } = deriveInviteKeys(secret, unb64(salt));
  const claim = await anon.json<{ tunnelId: string; wrapped: string; memberId: string; memberToken: string }>(
    'POST',
    `/v1/invites/${slot}/claim`,
    { verifier },
  );
  let payload: { tunnelId: string; name: string; key: string };
  try {
    payload = JSON.parse(open(wrapKey, unb64(claim.wrapped)).toString('utf8'));
  } catch {
    throw new TunnelError('The invite could not be unlocked. Ask for a new code.');
  }
  const rec: TunnelRecord = {
    name: ctx.store.uniqueName(slug(payload.name) || 'tunnel'),
    id: claim.tunnelId,
    relay,
    key: payload.key,
    memberId: claim.memberId,
    memberToken: claim.memberToken,
    me,
    cursor: 0,
    files: {},
  };
  await api(rec).json('PUT', tunnelPath(rec, '/members/me'), {
    profile: sealText(keyOf(rec), JSON.stringify({ name: me })),
  });
  ctx.store.saveTunnel(rec);
  ctx.store.setCurrent(rec.name);
  const others = (await peers(rec)).filter((p) => !p.you).map((p) => p.name);
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ tunnel: rec.name, me, peers: others }));
    return;
  }
  ctx.out(`Joined ${rec.name} as ${me}.` + (others.length ? ` Also here: ${others.join(', ')}.` : ''));
}

export async function sendCmd(ctx: Ctx, args: string[]) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  let text = args.join(' ');
  if (text === '-') text = ctx.stdin ? (await ctx.stdin()).replace(/\n$/, '') : '';
  const paths = ctx.flags.file ?? [];
  if (!text && paths.length === 0) {
    throw new UsageError('Nothing to send. Usage: tunnel send "message" [--file path] [--to name]');
  }
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    throw new UsageError('Message is over 64 KB. Send long content as a file with --file.');
  }

  const key = keyOf(rec);
  const files: FileRef[] = [];
  for (const p of paths) {
    const path = resolve(ctx.cwd, p);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      throw new UsageError(`Can't read ${p}.`);
    }
    // No plan takes more than Pro's limit, so refuse here instead of reading and sealing a huge file.
    // Below it the relay decides, by the plan of whoever opened the tunnel.
    if (size > PLANS.pro.fileBytes) {
      throw new UsageError(
        `${p} is ${formatSize(size)}. Files can be up to ${formatBytes(PLANS.pro.fileBytes)} on Pro, ` +
          `${formatBytes(PLANS.plus.fileBytes)} on Plus, ${formatBytes(PLANS.free.fileBytes)} on Free.`,
      );
    }
    const data = await readFile(path);
    const up = await api(rec).upload<{ fileId: string }>(tunnelPath(rec, '/files'), seal(key, data));
    files.push({ id: up.fileId, name: basename(path), size: data.length });
  }

  const message: Plain = { v: 1, from: rec.me, to: ctx.flags.to ?? null, text, files, at: Date.now() };
  const { seq } = await api(rec).json<{ seq: number }>('POST', tunnelPath(rec, '/messages'), {
    ct: sealMessage(key, message),
  });

  const others = (await peers(rec)).filter((p) => !p.you);
  const to = ctx.flags.to ? others.filter((p) => nameMatches(ctx.flags.to!, p.name)) : others;
  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ seq, to: to.map((p) => p.name), files }));
  } else if (to.length) {
    ctx.out(`Sent to ${to.map((p) => p.name).join(', ')}.`);
  } else if (ctx.flags.to) {
    ctx.out(`Sent. No one named "${ctx.flags.to}" is in ${rec.name} yet; it will wait in the mailbox.`);
  } else {
    ctx.out(`Sent. Nobody else is in ${rec.name} yet; it will wait in the mailbox.`);
  }
}

export async function inboxCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  const mine: Received[] = [];
  for (;;) {
    const page = await fetchAfter(ctx, rec, rec.cursor, 0);
    mine.push(...page.messages.filter((m) => isForMe(m, rec.me)));
    remember(rec, page.messages);
    rec.cursor = page.last;
    if (!page.full) break;
  }
  ctx.store.saveTunnel(rec);
  if (mine.length === 0) {
    if (ctx.flags.json) ctx.out('[]');
    else ctx.out(`No new messages in ${rec.name}.`);
    return;
  }
  print(ctx, rec, mine);
}

export async function waitCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  const timeout = seconds(ctx.flags.timeout, WAIT_DEFAULT_S);
  const deadline = Date.now() + timeout * 1000;
  while (!ctx.signal?.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const page = await fetchAfter(ctx, rec, rec.cursor, Math.min(LONG_POLL_S, Math.ceil(remaining / 1000)));
    remember(rec, page.messages);
    rec.cursor = page.last;
    const mine = page.messages.filter((m) => isForMe(m, rec.me));
    ctx.store.saveTunnel(rec);
    if (mine.length) {
      print(ctx, rec, mine);
      return;
    }
  }
  if (ctx.flags.json) ctx.out('[]');
  else ctx.out(`No new messages after ${timeout}s. Run \`tunnel wait\` again to keep waiting.`);
}

/** Follow the tunnel forever. Consumes messages like inbox. One line per message. */
export async function listenCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  ctx.err(`Listening on ${rec.name} as ${rec.me}. Ctrl+C to stop.`);
  let failures = 0;
  while (!ctx.signal?.aborted) {
    try {
      const page = await fetchAfter(ctx, rec, rec.cursor, LONG_POLL_S);
      failures = 0;
      remember(rec, page.messages);
      rec.cursor = page.last;
      ctx.store.saveTunnel(rec);
      for (const m of page.messages.filter((m) => isForMe(m, rec.me))) {
        ctx.out(ctx.flags.json ? JSON.stringify({ tunnel: rec.name, ...m }) : renderLine(m, rec.name));
      }
    } catch (error) {
      if (ctx.signal?.aborted) break;
      if (error instanceof TunnelError && (error as TunnelError & { status?: number }).status === 404) throw error;
      failures++;
      if (failures === 1) ctx.err(`${(error as Error).message} Retrying…`);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), ctx.signal);
    }
  }
}

/** For humans: show recent history (yours too) and follow, without marking anything read. */
export async function watchCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  const first = await fetchAfter(ctx, rec, Math.max(0, rec.cursor - 20), 0);
  let after = first.last;
  const show = (m: Received) => ctx.out(renderMessage(m, rec.name) + '\n');
  first.messages.forEach(show);
  ctx.err(`Watching ${rec.name}. Ctrl+C to stop.`);
  while (!ctx.signal?.aborted) {
    try {
      const page = await fetchAfter(ctx, rec, after, LONG_POLL_S);
      after = page.last;
      page.messages.forEach(show);
    } catch (error) {
      if (ctx.signal?.aborted) break;
      throw error;
    }
  }
}

export async function getCmd(ctx: Ctx, args: string[]) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  const id = args[0];
  if (!id) throw new UsageError('Usage: tunnel get <file-id> [-o path]');
  const sealed = await api(rec).download(tunnelPath(rec, `/files/${encodeURIComponent(id)}`));
  let data: Buffer;
  try {
    data = open(keyOf(rec), sealed);
  } catch {
    throw new TunnelError(`File ${id} could not be decrypted with this tunnel's key.`);
  }
  const known = rec.files[id]?.name ?? '';
  const safe = basename(known);
  let path = ctx.flags.out ? resolve(ctx.cwd, ctx.flags.out) : resolve(ctx.cwd, safe && safe !== '.' && safe !== '..' ? safe : id);
  if (!ctx.flags.force && existsSync(path)) {
    const ext = extname(path);
    const stem = path.slice(0, path.length - ext.length);
    for (let i = 1; existsSync(path); i++) path = `${stem}-${i}${ext}`;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  ctx.out(`Saved ${path} (${formatSize(data.length)}).`);
}

export async function peersCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  const list = await peers(rec);
  if (ctx.flags.json) {
    ctx.out(JSON.stringify(list.map(({ name, seen, you, owner }) => ({ name, seen, you, owner }))));
    return;
  }
  ctx.out(`${rec.name}: ${list.length} agent${list.length === 1 ? '' : 's'}`);
  for (const p of list) {
    const tags = [p.you ? 'you' : '', p.owner ? 'opened it' : ''].filter(Boolean).join(', ');
    ctx.out(`  ${p.name}${tags ? ` (${tags})` : ''}  last seen ${since(p.seen)}`);
  }
}

function since(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export async function lsCmd(ctx: Ctx) {
  const all = Object.values(ctx.store.tunnels());
  const current = ctx.store.config().current;
  if (ctx.flags.json) {
    ctx.out(JSON.stringify(all.map((t) => ({ name: t.name, me: t.me, relay: t.relay, current: t.name === current }))));
    return;
  }
  if (all.length === 0) {
    ctx.out('No tunnels yet. Run `tunnel open` or `tunnel join <code>`.');
    return;
  }
  for (const t of all) {
    const relay = t.relay === DEFAULT_RELAY ? '' : `  via ${t.relay}`;
    ctx.out(`${t.name === current ? '*' : ' '} ${t.name}  as ${t.me}${relay}`);
  }
}

export async function useCmd(ctx: Ctx, args: string[]) {
  if (!args[0]) throw new UsageError('Usage: tunnel use <name>');
  const rec = ctx.store.tunnel(args[0]);
  ctx.store.setCurrent(rec.name);
  ctx.out(`Now using ${rec.name}.`);
}

export async function leaveCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  await api(rec).json('DELETE', tunnelPath(rec, '/members/me'));
  ctx.store.removeTunnel(rec.name);
  ctx.out(`Left ${rec.name}.`);
}

export async function closeCmd(ctx: Ctx) {
  const rec = ctx.store.tunnel(ctx.flags.tunnel);
  await api(rec).json('DELETE', tunnelPath(rec));
  ctx.store.removeTunnel(rec.name);
  ctx.out(`Closed ${rec.name}. Its messages and files were deleted from the relay.`);
}

export async function relayCmd(ctx: Ctx) {
  const { startRelay } = await import('./relay/server.js');
  const port = Number(ctx.flags.port ?? ctx.env.PORT ?? 8787);
  const dataDir = resolve(ctx.cwd, ctx.flags.data ?? ctx.env.TUNNEL_DATA ?? 'tunnel-data');
  const relay = await startRelay({
    port,
    host: ctx.flags.host ?? ctx.env.HOST ?? '0.0.0.0',
    dataDir,
    maxTunnelsPerDevice: Number(ctx.env.TUNNEL_MAX_TUNNELS ?? 0) || 0,
    trustProxy: ctx.env.TUNNEL_TRUST_PROXY === '1',
    env: ctx.env,
    log: (line) => ctx.err(line),
  });
  ctx.out(`Relay running on port ${port}. Data in ${dataDir}.`);
  ctx.out(`Agents connect with: --relay http://<this-host>:${port}  (or set TUNNEL_RELAY)`);
  ctx.out('Messages are end-to-end encrypted, but put the relay behind HTTPS before exposing it to the internet.');
  await new Promise<void>((resolveStop) => {
    if (ctx.signal?.aborted) return resolveStop();
    ctx.signal?.addEventListener('abort', () => resolveStop(), { once: true });
  });
  await relay.close();
}
