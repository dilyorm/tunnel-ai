import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_NETWORK_HINT, run } from '../src/cli.js';
import { RelayClient, seenVersions } from '../src/relay-client.js';
import { detectLayout, updateBase, updateHint, type UpdateHooks } from '../src/update.js';
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

describe('update base', () => {
  test('defaults to the hosted site', () => {
    assert.equal(updateBase({}), 'https://tunnel.dilyor.dev');
  });

  test('uses TUNNEL_DOWNLOAD without trailing slashes', () => {
    assert.equal(updateBase({ TUNNEL_DOWNLOAD: 'http://mirror.test:8080' }), 'http://mirror.test:8080');
    assert.equal(updateBase({ TUNNEL_DOWNLOAD: 'http://mirror.test/' }), 'http://mirror.test');
    assert.equal(updateBase({ TUNNEL_DOWNLOAD: 'http://mirror.test///' }), 'http://mirror.test');
  });

  test('an empty TUNNEL_DOWNLOAD falls back to the hosted site', () => {
    assert.equal(updateBase({ TUNNEL_DOWNLOAD: '' }), 'https://tunnel.dilyor.dev');
  });
});

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

  test('only a hint more than 24 hours old is stale: exactly 24 hours still suppresses', () => {
    assert.equal(updateHint({ ...base, lastHintAt: base.now - DAY }), undefined);
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
      // In each case the command succeeds and the relay did report its version, so only the rules keep the hint quiet.
      const selfHosted = await machine(newer).run('open', 'a');
      assert.equal(selfHosted.code, 0, selfHosted.err);
      assert.equal(seenVersions.get(newer.url), '9.9.9');
      assert.equal(count(selfHosted.err, 'is out'), 0);

      const optedOut = await machine(newer, { TUNNEL_DOWNLOAD: newer.url, TUNNEL_NO_UPDATE_CHECK: '1' }).run('open', 'b');
      assert.equal(optedOut.code, 0, optedOut.err);
      assert.equal(seenVersions.get(newer.url), '9.9.9');
      assert.equal(count(optedOut.err, 'is out'), 0);

      const current = await machine(same, { TUNNEL_DOWNLOAD: same.url }).run('open', 'c');
      assert.equal(current.code, 0, current.err);
      assert.equal(seenVersions.get(same.url), VERSION);
      assert.equal(count(current.err, 'is out'), 0);
    } finally {
      await newer.close();
      await same.close();
    }
  });

  test('a config.json that cannot be saved gives no hint, rather than a hint on every command', async () => {
    const r = await relay({ version: '9.9.9' });
    try {
      const m = machine(r, { TUNNEL_DOWNLOAD: r.url });
      const opened = await m.run('open', 'locked');
      assert.equal(opened.code, 0, opened.err);
      // saveConfig writes config.json.<pid>.tmp and renames it over config.json. A directory in the way makes it throw.
      mkdirSync(join(m.home, `config.json.${process.pid}.tmp`));
      m.setHintAt(Date.now() - DAY - 1000);
      for (let i = 0; i < 3; i++) {
        const res = await m.run('peers', '--json');
        assert.equal(res.code, 0, res.err);
        assert.equal(seenVersions.get(r.url), '9.9.9', 'the relay reported a newer version, so the hint was due');
        assert.equal(res.err, '');
        assert.ok(Array.isArray(JSON.parse(res.out)), 'stdout stays one JSON document');
      }
    } finally {
      await r.close();
    }
  });
});

describe('install layout', () => {
  const has = (...paths: string[]) => (path: string) => paths.includes(path);

  test('a script install on macOS or Linux', () => {
    assert.deepEqual(detectLayout('/home/a/.tunnel/lib/tunnel-ai/dist/bin.js', has('/home/a/.tunnel/bin/tunnel')), {
      kind: 'script',
      dir: '/home/a/.tunnel',
    });
  });

  test('a script install on Windows, in a folder with a space', () => {
    assert.deepEqual(
      detectLayout('C:\\Users\\A B\\.tunnel\\lib\\tunnel-ai\\dist\\bin.js', has('C:\\Users\\A B\\.tunnel\\bin\\tunnel.cmd')),
      { kind: 'script', dir: 'C:\\Users\\A B\\.tunnel' },
    );
  });

  test('npm installs, and anything else', () => {
    assert.deepEqual(detectLayout('/usr/lib/node_modules/tunnel-ai/dist/bin.js', has()), { kind: 'npm' });
    assert.deepEqual(detectLayout('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\tunnel-ai\\dist\\bin.js', has()), {
      kind: 'npm',
    });
    assert.deepEqual(detectLayout('/home/a/.tunnel/lib/tunnel-ai/dist/bin.js', has()), { kind: 'unknown' });
    assert.deepEqual(detectLayout('/src/tunnel-ai/cli/src/bin.ts', has()), { kind: 'unknown' });
  });
});

describe('tunnel update', () => {
  interface Call {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
  }

  /** Stand-ins for the network and child processes. `health` is what /v1/health answers. */
  function fake(o: {
    binPath: string;
    files?: string[];
    platform?: NodeJS.Platform;
    health?: () => Response;
    /** What install.sh / install.ps1 downloads as. */
    installer?: () => Response;
    installExit?: number;
    /** What `bin.js --version` prints. It runs once after a failed install and once after a good one, never both. */
    after?: string;
    /** The exit code of that `--version` run: non-zero means tunnel no longer starts. */
    afterExit?: number;
  }) {
    const calls: Call[] = [];
    const fetched: string[] = [];
    const dir = tmp('update-tmp');
    const hooks: Partial<UpdateHooks> = {
      binPath: o.binPath,
      execPath: '/node',
      platform: o.platform ?? 'linux',
      exists: (path) => (o.files ?? []).includes(path),
      tmpdir: () => dir,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith('/v1/health')) return o.health ? o.health() : Response.json({ ok: true, version: '9.9.9' });
        if (/\/install\.(sh|ps1)$/.test(url)) return o.installer ? o.installer() : new Response('echo installing\n');
        return new Response('missing', { status: 404 });
      }) as typeof fetch,
      spawn: async (command, args, options) => {
        calls.push({ command, args, env: options.env, shell: options.shell });
        return command === '/node' ? 0 : (o.installExit ?? 0);
      },
      capture: async (command, args) => {
        calls.push({ command, args });
        return o.afterExit ? { code: o.afterExit, stdout: '' } : { code: 0, stdout: `${o.after ?? '9.9.9'}\n` };
      },
    };
    return { hooks, calls, fetched, dir };
  }

  async function update(hooks: Partial<UpdateHooks>, env: Record<string, string> = { TUNNEL_DOWNLOAD: 'https://dl.test' }) {
    let out = '';
    let err = '';
    const code = await run(['update'], {
      env: { TUNNEL_HOME: tmp('update-home'), ...env },
      out: (s) => (out += s + '\n'),
      err: (s) => (err += s + '\n'),
      update: hooks,
    });
    return { code, out, err };
  }

  const SCRIPT = '/home/a/.tunnel/lib/tunnel-ai/dist/bin.js';

  test('already up to date when the latest is not newer', async () => {
    for (const latest of [VERSION, '0.0.1']) {
      const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], health: () => Response.json({ ok: true, version: latest }) });
      const r = await update(f.hooks);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, `Already up to date (${VERSION}).\n`);
      assert.deepEqual(f.calls, []);
    }
  });

  test('checks the hosted site unless TUNNEL_DOWNLOAD says otherwise', async () => {
    const f = fake({ binPath: SCRIPT, health: () => Response.json({ ok: true, version: VERSION }) });
    await update(f.hooks, {});
    assert.equal(f.fetched[0], 'https://tunnel.dilyor.dev/v1/health');
  });

  test('a script install runs install.sh into its own folder, checks the version, then refreshes skills', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'] });
    const r = await update(f.hooks);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(f.fetched, ['https://dl.test/v1/health', 'https://dl.test/install.sh']);
    const [install, version, refresh] = f.calls;
    assert.equal(install.command, 'sh');
    assert.equal(install.args.length, 1);
    assert.match(install.args[0], /install\.sh$/);
    assert.equal(install.shell, false);
    assert.equal(install.env?.TUNNEL_INSTALL, '/home/a/.tunnel');
    assert.equal(install.env?.TUNNEL_NO_MODIFY_PATH, '1');
    assert.equal(install.env?.TUNNEL_DOWNLOAD, 'https://dl.test');
    assert.deepEqual(version, { command: '/node', args: [SCRIPT, '--version'] });
    assert.equal(refresh.command, '/node');
    assert.deepEqual(refresh.args, [SCRIPT, 'skills', 'install', '--refresh']);
    assert.equal(f.calls.length, 3);
    assert.equal(r.out, `Updated tunnel ${VERSION} → 9.9.9.\n`);
    assert.deepEqual(readdirSync(f.dir), [], 'the downloaded installer is deleted');
  });

  test('a script install on Windows runs install.ps1 through PowerShell, spaces and all', async () => {
    const bin = 'C:\\Users\\A B\\.tunnel\\lib\\tunnel-ai\\dist\\bin.js';
    const f = fake({ binPath: bin, platform: 'win32', files: ['C:\\Users\\A B\\.tunnel\\bin\\tunnel.cmd'] });
    const r = await update(f.hooks);
    assert.equal(r.code, 0, r.err);
    const [install] = f.calls;
    assert.equal(install.command, 'powershell');
    assert.deepEqual(install.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']);
    assert.match(install.args[4], /install\.ps1$/);
    assert.equal(install.shell, false);
    assert.equal(install.env?.TUNNEL_INSTALL, 'C:\\Users\\A B\\.tunnel');
    assert.equal(install.env?.TUNNEL_NO_MODIFY_PATH, '1');
    assert.equal(install.env?.TUNNEL_DOWNLOAD, 'https://dl.test');
    assert.equal(f.fetched[1], 'https://dl.test/install.ps1');
    assert.deepEqual(readdirSync(f.dir), [], 'the downloaded installer is deleted');
  });

  test('an npm install runs npm i -g on the tarball, through a shell on Windows', async () => {
    const linux = fake({ binPath: '/usr/lib/node_modules/tunnel-ai/dist/bin.js' });
    assert.equal((await update(linux.hooks)).code, 0);
    assert.deepEqual(
      { command: linux.calls[0].command, args: linux.calls[0].args, shell: linux.calls[0].shell },
      { command: 'npm', args: ['i', '-g', 'https://dl.test/tunnel-ai.tgz'], shell: false },
    );
    const windows = fake({ binPath: 'C:\\npm\\node_modules\\tunnel-ai\\dist\\bin.js', platform: 'win32' });
    assert.equal((await update(windows.hooks)).code, 0);
    assert.equal(windows.calls[0].shell, true);
  });

  test('an unknown layout prints how to update by hand and changes nothing', async () => {
    const f = fake({ binPath: '/src/tunnel-ai/cli/src/bin.ts' });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.match(r.err, /can't update itself/);
    assert.match(r.err, /curl -fsSL https:\/\/dl\.test\/install\.sh \| sh/);
    assert.match(r.err, /irm https:\/\/dl\.test\/install\.ps1 \| iex/);
    assert.match(r.err, /npm i -g https:\/\/dl\.test\/tunnel-ai\.tgz/);
    assert.deepEqual(f.calls, []);
  });

  /** The same install commands `tunnel update` prints when it can't update itself, for the base https://dl.test. */
  const REINSTALL = [
    '  macOS and Linux:  curl -fsSL https://dl.test/install.sh | sh',
    '  Windows:          irm https://dl.test/install.ps1 | iex',
    '  npm:              npm i -g https://dl.test/tunnel-ai.tgz',
  ].join('\n');
  const VERSION_PROBE = { command: '/node', args: [SCRIPT, '--version'] };

  test('a failing installer is reported, and skills are left alone, when tunnel still runs', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], installExit: 3, after: VERSION });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(r.err, `The update failed (install.sh exited with 3). Your current tunnel ${VERSION} still works.\n`);
    assert.equal(f.calls.length, 2, 'the installer, then the check that tunnel still starts');
    assert.deepEqual(f.calls[1], VERSION_PROBE);
    assert.deepEqual(readdirSync(f.dir), [], 'the downloaded installer is deleted when it fails too');
  });

  test('a failing installer that left tunnel unable to start says so, and how to reinstall', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], installExit: 3, afterExit: 1 });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(
      r.err,
      `The update failed (install.sh exited with 3), and tunnel no longer starts. Reinstall it:\n${REINSTALL}\n`,
    );
    assert.doesNotMatch(r.err, /still works/);
    assert.equal(f.calls.length, 2, 'no skills refresh');
    assert.deepEqual(f.calls[1], VERSION_PROBE);
    assert.deepEqual(readdirSync(f.dir), [], 'the downloaded installer is deleted when it fails too');
  });

  test('a failing installer after which tunnel reports another version does not claim it still works', async () => {
    for (const after of ['0.1.0', '9.9.9']) {
      const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], installExit: 3, after });
      const r = await update(f.hooks);
      assert.equal(r.code, 1);
      assert.equal(r.err, `The update failed (install.sh exited with 3), and tunnel reports ${after}. Reinstall it:\n${REINSTALL}\n`);
      assert.equal(f.calls.length, 2, 'no skills refresh');
    }
  });

  test('an installer that exits 0 without updating is caught by the version check', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], after: VERSION });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(
      r.err,
      `The update failed (install.sh finished, but tunnel still reports ${VERSION}). Your current tunnel ${VERSION} still works.\n`,
    );
    assert.equal(f.calls.length, 2, 'no skills refresh');
    assert.deepEqual(readdirSync(f.dir), [], 'the downloaded installer is deleted');
  });

  test('an installer that exits 0 but leaves tunnel unable to start says so, and how to reinstall', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], afterExit: 1 });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(
      r.err,
      `The update failed (install.sh finished, but tunnel no longer starts). Reinstall it:\n${REINSTALL}\n`,
    );
    assert.doesNotMatch(r.err, /still works/);
    assert.equal(f.calls.length, 2, 'no skills refresh');
    assert.deepEqual(f.calls[1], VERSION_PROBE);
    assert.deepEqual(readdirSync(f.dir), [], 'the downloaded installer is deleted');
  });

  test('an installer that exits 0 after which tunnel reports an older version or nothing does not claim it still works', async () => {
    const older = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], after: '0.1.0' });
    const r = await update(older.hooks);
    assert.equal(r.code, 1);
    assert.equal(r.err, `The update failed (install.sh finished, but tunnel reports 0.1.0). Reinstall it:\n${REINSTALL}\n`);
    assert.equal(older.calls.length, 2, 'no skills refresh');
    // Exit 0 with no output is not a tunnel that runs.
    const silent = await update(fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], after: '' }).hooks);
    assert.equal(silent.err, `The update failed (install.sh finished, but tunnel no longer starts). Reinstall it:\n${REINSTALL}\n`);
  });

  test('an unreachable update server, with the Codex hint inside Codex', async () => {
    const down = () => {
      throw new TypeError('fetch failed');
    };
    const f = fake({ binPath: SCRIPT, health: down });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(r.err, "Couldn't reach dl.test to check for updates.\n");
    const codex = await update(fake({ binPath: SCRIPT, health: down }).hooks, {
      TUNNEL_DOWNLOAD: 'https://dl.test',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
    });
    assert.equal(codex.err, `Couldn't reach dl.test to check for updates.\n${CODEX_NETWORK_HINT}\n`);
  });

  test('a health answer without a version (a captive portal page) changes nothing', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], health: () => new Response('<html>Sign in to Wi-Fi</html>') });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(r.err, "dl.test didn't say which version is latest. Try again later.\n");
    assert.deepEqual(f.calls, []);
  });

  describe('when npm fails', () => {
    const NPM_BIN = '/usr/lib/node_modules/tunnel-ai/dist/bin.js';
    const npmProbe = { command: '/node', args: [NPM_BIN, '--version'] };

    test('it is reported as npm, and only the check that tunnel still runs follows', async () => {
      const f = fake({ binPath: NPM_BIN, installExit: 4, after: VERSION });
      const r = await update(f.hooks);
      assert.equal(r.code, 1);
      assert.equal(r.err, `The update failed (npm exited with 4). Your current tunnel ${VERSION} still works.\n`);
      assert.equal(f.calls.length, 2, 'npm, then the check that tunnel still starts; no skills refresh');
      assert.deepEqual(f.calls[1], npmProbe);
    });

    test('and tunnel no longer starts, it says so and how to reinstall', async () => {
      const f = fake({ binPath: NPM_BIN, installExit: 4, afterExit: 1 });
      const r = await update(f.hooks);
      assert.equal(r.code, 1);
      assert.equal(r.err, `The update failed (npm exited with 4), and tunnel no longer starts. Reinstall it:\n${REINSTALL}\n`);
      assert.doesNotMatch(r.err, /still works/);
      assert.equal(f.calls.length, 2, 'no skills refresh');
      assert.deepEqual(f.calls[1], npmProbe);
    });

    test('and npm exits 0 but tunnel no longer starts, it says so and how to reinstall', async () => {
      const f = fake({ binPath: NPM_BIN, afterExit: 1 });
      const r = await update(f.hooks);
      assert.equal(r.code, 1);
      assert.equal(r.err, `The update failed (npm finished, but tunnel no longer starts). Reinstall it:\n${REINSTALL}\n`);
      assert.equal(f.calls.length, 2, 'no skills refresh');
    });

    test('and npm exits 0 without updating, tunnel still works', async () => {
      const f = fake({ binPath: NPM_BIN, after: VERSION });
      const r = await update(f.hooks);
      assert.equal(r.code, 1);
      assert.equal(
        r.err,
        `The update failed (npm finished, but tunnel still reports ${VERSION}). Your current tunnel ${VERSION} still works.\n`,
      );
    });
  });

  test('a timeout on the update server is reported without the Codex hint', async () => {
    const slow = () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    const r = await update(fake({ binPath: SCRIPT, health: slow }).hooks, {
      TUNNEL_DOWNLOAD: 'https://dl.test',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
    });
    assert.equal(r.code, 1);
    assert.equal(r.err, "Couldn't reach dl.test to check for updates.\n");
  });

  test('a TUNNEL_DOWNLOAD that is not an http:// or https:// URL is refused before anything is fetched or run', async () => {
    for (const bad of ['dl.example.com', 'dl.example.com:8080', 'ftp://dl.test', 'https://']) {
      const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'] });
      const r = await update(f.hooks, { TUNNEL_DOWNLOAD: bad });
      assert.equal(r.code, 1, bad);
      assert.equal(
        r.err,
        `TUNNEL_DOWNLOAD must be an http:// or https:// URL, like https://tunnel.example.com (it is "${bad.replace(/\/+$/, '')}").\n`,
      );
      assert.deepEqual(f.fetched, []);
      assert.deepEqual(f.calls, []);
    }
  });

  test('a TUNNEL_DOWNLOAD with characters cmd.exe would act on is refused, before anything is fetched or run', async () => {
    const bads = ['https://dl.test/a&calc', 'https://dl.test/a|b', 'https://dl.test/<a>', 'https://dl.test/a^b'];
    for (const bad of [...bads, 'https://dl.test/%PATH%', 'https://dl.test/a b', 'https://dl.test/"a']) {
      const f = fake({ binPath: 'C:\\npm\\node_modules\\tunnel-ai\\dist\\bin.js', platform: 'win32' });
      const r = await update(f.hooks, { TUNNEL_DOWNLOAD: bad });
      assert.equal(r.code, 1, bad);
      assert.equal(r.err, `TUNNEL_DOWNLOAD can't contain spaces or any of " & | < > ^ % (it is "${bad}").\n`);
      assert.deepEqual(f.fetched, []);
      assert.deepEqual(f.calls, []);
    }
  });

  test('a download that dies partway is reported like any other failed download', async () => {
    const cut = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
      );
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], installer: cut });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(r.err, `Couldn't download https://dl.test/install.sh. Your current tunnel ${VERSION} still works.\n`);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(readdirSync(f.dir), []);
  });

  test('an installer the server does not serve is reported with its status', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'], installer: () => new Response('no', { status: 503 }) });
    const r = await update(f.hooks);
    assert.equal(r.code, 1);
    assert.equal(r.err, `Couldn't download https://dl.test/install.sh (503). Your current tunnel ${VERSION} still works.\n`);
    assert.deepEqual(f.calls, []);
  });

  test('an installer that cannot be saved is reported, and nothing runs', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'] });
    const missing = join(f.dir, 'not-a-folder');
    const r = await update({ ...f.hooks, tmpdir: () => missing });
    assert.equal(r.code, 1);
    assert.equal(r.err, `Couldn't save the installer in ${missing} (ENOENT). Your current tunnel ${VERSION} still works.\n`);
    assert.deepEqual(f.calls, []);
  });

  test('a temp file that cannot be deleted does not stop the version check or the skills refresh', async () => {
    const f = fake({ binPath: SCRIPT, files: ['/home/a/.tunnel/bin/tunnel'] });
    const installer = f.hooks.spawn!;
    // Put a folder where the installer file was, so deleting it throws, as a virus scanner's lock can on Windows.
    f.hooks.spawn = async (command, args, options) => {
      if (command === 'sh') {
        rmSync(args[0]);
        mkdirSync(args[0]);
      }
      return installer(command, args, options);
    };
    const r = await update(f.hooks);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.err, '');
    assert.equal(r.out, `Updated tunnel ${VERSION} → 9.9.9.\n`);
    assert.deepEqual(
      f.calls.map((call) => call.command),
      ['sh', '/node', '/node'],
    );
    assert.deepEqual(f.calls[2].args, [SCRIPT, 'skills', 'install', '--refresh']);
  });
});

describe('install.ps1', () => {
  test('is plain ASCII: tunnel update saves it without a BOM, and Windows PowerShell 5.1 would read that as ANSI', () => {
    const text = readFileSync(new URL('../../site/public/install.ps1', import.meta.url)).toString('latin1');
    // latin1 turns each byte into one character, so a character above 0x7F is a byte above 0x7F.
    const at = text.search(/[^\x00-\x7f]/);
    const line = text.slice(0, at).split('\n').length;
    assert.ok(at === -1, `site/public/install.ps1 line ${line} has a byte above 0x7F: ${JSON.stringify(text.split('\n')[line - 1])}`);
  });
});
