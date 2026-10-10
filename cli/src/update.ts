import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RELAY, type Ctx } from './commands.js';
import { TunnelError, UnreachableError } from './errors.js';
import { isNewer, VERSION } from './version.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where releases come from: the hosted site, or $TUNNEL_DOWNLOAD (the installers read the same variable). */
export function updateBase(env: NodeJS.ProcessEnv): string {
  return (env.TUNNEL_DOWNLOAD || DEFAULT_RELAY).replace(/\/+$/, '');
}

export interface HintInput {
  command: string;
  /** The version the release relay reported during this run, if the run talked to it. */
  seen?: string;
  current: string;
  now: number;
  /** config.json's updateHintAt, unchecked: people edit that file by hand. */
  lastHintAt?: unknown;
  /** TUNNEL_NO_UPDATE_CHECK=1. */
  optOut: boolean;
}

/** The once-a-day line saying a newer tunnel is out, or undefined when there is nothing to say. */
export function updateHint(input: HintInput): string | undefined {
  if (input.optOut || input.command === 'update' || input.command === 'relay') return undefined;
  if (!input.seen || !isNewer(input.seen, input.current)) return undefined;
  const last = input.lastHintAt;
  // Stale means more than a day old, so exactly 24 hours still counts as shown.
  // A time in the future means the clock moved back: treat it as stale, like a missing one.
  if (typeof last === 'number' && last <= input.now && input.now - last <= DAY_MS) return undefined;
  return `tunnel ${input.seen} is out (you have ${input.current}). Run \`tunnel update\` to get it.`;
}

/** Everything `tunnel update` touches outside its own process. Tests replace these. */
export interface UpdateHooks {
  /** The dist/bin.js this tunnel runs from. */
  binPath: string;
  /** The node running it. */
  execPath: string;
  platform: NodeJS.Platform;
  exists(path: string): boolean;
  fetch: typeof fetch;
  tmpdir(): string;
  /** Run a command attached to this terminal; resolves to its exit code. */
  spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv; shell: boolean }): Promise<number>;
  /** Run a command and collect what it prints. */
  capture(command: string, args: string[]): Promise<{ code: number; stdout: string }>;
}

export function realHooks(): UpdateHooks {
  return {
    binPath: fileURLToPath(new URL('./bin.js', import.meta.url)),
    execPath: process.execPath,
    platform: process.platform,
    exists: existsSync,
    fetch: globalThis.fetch.bind(globalThis),
    tmpdir,
    spawn: (command, args, { env, shell }) =>
      new Promise((resolve) => {
        // A shell is only for npm.cmd on Windows, whose arguments are fixed words, so one command line is safe.
        const child = shell
          ? spawn([command, ...args].join(' '), { env, shell: true, stdio: 'inherit' })
          : spawn(command, args, { env, stdio: 'inherit' });
        child.on('error', () => resolve(127));
        child.on('close', (code) => resolve(code ?? 1));
      }),
    capture: (command, args) =>
      new Promise((resolve) => {
        execFile(command, args, (error, stdout) =>
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout) }),
        );
      }),
  };
}

export type Layout = { kind: 'script'; dir: string } | { kind: 'npm' } | { kind: 'unknown' };

/** How this tunnel was installed, from where its bin.js lives. Works on / and \ paths alike. */
export function detectLayout(binPath: string, exists: (path: string) => boolean): Layout {
  const script = /^(.*)[\\/]lib[\\/]tunnel-ai[\\/]dist[\\/]bin\.js$/.exec(binPath);
  if (script) {
    const dir = script[1];
    const sep = binPath.includes('\\') ? '\\' : '/';
    const bin = `${dir}${sep}bin${sep}`;
    if (exists(`${bin}tunnel`) || exists(`${bin}tunnel.cmd`)) return { kind: 'script', dir };
  }
  if (/[\\/]node_modules[\\/]tunnel-ai[\\/]dist[\\/]bin\.js$/.test(binPath)) return { kind: 'npm' };
  return { kind: 'unknown' };
}

/** Update to the latest release the way tunnel was installed, then refresh the installed skills. */
export async function updateCmd(ctx: Ctx) {
  const hooks: UpdateHooks = { ...realHooks(), ...ctx.update };
  const base = updateBase(ctx.env);
  const latest = await latestVersion(hooks, base);
  if (!isNewer(latest, VERSION)) {
    ctx.out(`Already up to date (${VERSION}).`);
    return;
  }
  const layout = detectLayout(hooks.binPath, hooks.exists);
  if (layout.kind === 'unknown') throw new TunnelError(updateByHand(hooks.binPath, base));
  const step = layout.kind === 'script' ? await runInstaller(ctx, hooks, base, layout.dir) : await runNpm(ctx, hooks, base);
  if (step.code !== 0) {
    throw new TunnelError(`The update failed (${step.label} exited with ${step.code}). Your current tunnel ${VERSION} still works.`);
  }
  // Both installs replace the files in place, so the same bin.js now holds the new version.
  // install.ps1 reports errors but exits 0, so the version is what proves it worked.
  const after = await hooks.capture(hooks.execPath, [hooks.binPath, '--version']);
  const now = after.stdout.trim();
  if (after.code !== 0 || !isNewer(now, VERSION)) {
    throw new TunnelError(
      `The update failed (${step.label} finished, but tunnel still reports ${now || VERSION}). Your current tunnel ${VERSION} still works.`,
    );
  }
  ctx.out(`Updated tunnel ${VERSION} → ${now}.`);
  await hooks.spawn(hooks.execPath, [hooks.binPath, 'skills', 'install', '--refresh'], { env: ctx.env, shell: false });
}

async function latestVersion(hooks: UpdateHooks, base: string): Promise<string> {
  const host = new URL(base).host;
  let res: Response;
  try {
    res = await hooks.fetch(`${base}/v1/health`, {
      headers: { 'user-agent': `tunnel-ai/${VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = `Couldn't reach ${host} to check for updates.`;
    throw (error as Error).name === 'TimeoutError' ? new TunnelError(message) : new UnreachableError(message);
  }
  let version: unknown;
  try {
    version = ((await res.json()) as { version?: unknown }).version;
  } catch {
    // not JSON, e.g. a Wi-Fi sign-in page
  }
  if (!res.ok || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new TunnelError(`${host} didn't say which version is latest. Try again later.`);
  }
  return version;
}

async function download(hooks: UpdateHooks, url: string): Promise<string> {
  let res: Response;
  try {
    res = await hooks.fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new TunnelError(`Couldn't download ${url}. Your current tunnel ${VERSION} still works.`);
  }
  if (!res.ok) throw new TunnelError(`Couldn't download ${url} (${res.status}). Your current tunnel ${VERSION} still works.`);
  return res.text();
}

/** Re-run the install script into the folder tunnel already lives in, leaving PATH alone. */
async function runInstaller(ctx: Ctx, hooks: UpdateHooks, base: string, dir: string) {
  const windows = hooks.platform === 'win32';
  const label = windows ? 'install.ps1' : 'install.sh';
  const script = await download(hooks, `${base}/${label}`);
  const file = join(hooks.tmpdir(), `tunnel-${randomUUID()}-${label}`);
  writeFileSync(file, script);
  const env = { ...ctx.env, TUNNEL_INSTALL: dir, TUNNEL_NO_MODIFY_PATH: '1', TUNNEL_DOWNLOAD: base };
  try {
    const code = windows
      ? await hooks.spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { env, shell: false })
      : await hooks.spawn('sh', [file], { env, shell: false });
    return { code, label };
  } finally {
    rmSync(file, { force: true });
  }
}

async function runNpm(ctx: Ctx, hooks: UpdateHooks, base: string) {
  const code = await hooks.spawn('npm', ['i', '-g', `${base}/tunnel-ai.tgz`], {
    env: ctx.env,
    shell: hooks.platform === 'win32',
  });
  return { code, label: 'npm' };
}

function updateByHand(binPath: string, base: string): string {
  return [
    `tunnel can't update itself from ${binPath}: that isn't an install-script or npm install.`,
    'Update it the way you installed it:',
    `  macOS and Linux:  curl -fsSL ${base}/install.sh | sh`,
    `  Windows:          irm ${base}/install.ps1 | iex`,
    `  npm:              npm i -g ${base}/tunnel-ai.tgz`,
  ].join('\n');
}
