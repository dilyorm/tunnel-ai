import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CODEX_NETWORK_HINT, HELP, run } from '../src/cli.js';
import { agentKind, WAIT_DEFAULT_S } from '../src/commands.js';
import { secretToken } from '../src/crypto.js';
import { TunnelError, UnreachableError } from '../src/errors.js';
import { RelayClient } from '../src/relay-client.js';
import { Store } from '../src/store.js';
import { relay, tmp } from './helpers.js';

/** Run the CLI in-process with its own ~/.tunnel and the given extra env. */
async function cli(env: Record<string, string>, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    env: { TUNNEL_HOME: tmp('agents-state'), ...env },
    cwd: tmp('agents-cwd'),
    out: (s) => (out += s + '\n'),
    err: (s) => (err += s + '\n'),
  });
  return { code, out, err };
}

/** A URL where nothing listens: a port that was free a moment ago. */
async function deadUrl() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('relay unreachable', () => {
  test('inside the Codex sandbox, the error says how to allow network', async () => {
    const url = await deadUrl();
    const r = await cli({ TUNNEL_RELAY: url, CODEX_SANDBOX_NETWORK_DISABLED: '1' }, 'open', 'x');
    assert.equal(r.code, 1);
    assert.equal(
      r.err,
      `The relay at ${url} is unreachable. Check your connection, or point to another relay with --relay.\n${CODEX_NETWORK_HINT}\n`,
    );
  });

  test('outside Codex the error is one line', async () => {
    const url = await deadUrl();
    const r = await cli({ TUNNEL_RELAY: url }, 'open', 'x');
    assert.equal(r.code, 1);
    assert.equal(r.err, `The relay at ${url} is unreachable. Check your connection, or point to another relay with --relay.\n`);
  });

  test('a relay that times out is not called unreachable', async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket)); // accepts, never answers
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await assert.rejects(
        new RelayClient(`http://127.0.0.1:${port}`).json('GET', '/v1/health', undefined, { timeoutMs: 200 }),
        (error: unknown) =>
          error instanceof TunnelError && !(error instanceof UnreachableError) && /timed out/.test(error.message),
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('agent names', () => {
  const cases: [Record<string, string>, string][] = [
    [{ CLAUDECODE: '1' }, 'claude'],
    [{ CODEX_THREAD_ID: 't_1' }, 'codex'],
    [{ CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt' }, 'claude'],
    [{ KILO_PID: '42', OPENCODE: '1' }, 'kilo'],
    [{ OPENCODE: '1' }, 'opencode'],
    [{ GEMINI_CLI: '1' }, 'gemini'],
    [{ CURSOR_AGENT: '1' }, 'cursor'],
    [{ COPILOT_CLI: '1' }, 'copilot'],
    [{ GOOSE_TERMINAL: '1' }, 'goose'],
    [{ CRUSH: '1', AI_AGENT: 'crush' }, 'crush'],
    [{ QWEN_CODE: '1' }, 'qwen'],
    [{ PI_CODING_AGENT: 'true', AI_AGENT: 'pi' }, 'pi'],
    [{ AI_AGENT: 'Warp' }, 'warp'],
    [{ OPENCODE: '1', AI_AGENT: 'warp' }, 'opencode'],
    [{ CODEX_X: '1', KILO_PID: '1' }, 'codex'],
  ];
  for (const [env, name] of cases) {
    test(`${Object.keys(env).join(' + ')} names the agent ${name}`, () => assert.equal(agentKind(env), name));
  }

  test('an AI_AGENT that is not a plain name falls back to the default', () => {
    const fallback = agentKind({});
    for (const bad of ['Claude Code', '1abc', 'a'.repeat(33), 'x/y', '']) assert.equal(agentKind({ AI_AGENT: bad }), fallback);
  });

  test('the guessed name is used when --as is left out, and --as wins over it', async () => {
    const r = await relay();
    try {
      const guessed = await cli({ TUNNEL_RELAY: r.url, OPENCODE: '1' }, 'open', 'guess');
      assert.equal(guessed.code, 0, guessed.err);
      assert.match(guessed.out, /You are opencode@/);
      const chosen = await cli({ TUNNEL_RELAY: r.url, CLAUDECODE: '1' }, 'open', 'chosen', '--as', 'bob');
      assert.equal(chosen.code, 0, chosen.err);
      assert.match(chosen.out, /You are bob@/);
    } finally {
      await r.close();
    }
  });
});

describe('tunnel wait default', () => {
  test('waits 90 seconds by default, as the help says', () => {
    assert.equal(WAIT_DEFAULT_S, 90);
    assert.match(HELP, /tunnel wait \[--timeout 90\]/);
  });

  /**
   * Run `tunnel wait` against a stub relay that answers every long poll with no messages, after moving
   * the clock forward by the seconds it was asked to wait. Returns those seconds, one per poll.
   */
  async function pollsOf(...flags: string[]) {
    const polls: number[] = [];
    const stub = createHttpServer((req, res) => {
      const seconds = Number(new URL(req.url ?? '', 'http://stub').searchParams.get('wait'));
      polls.push(seconds);
      mock.timers.tick(seconds * 1000);
      res.setHeader('content-type', 'application/json').end(JSON.stringify({ messages: [], latest: 0 }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const home = tmp('agents-wait');
    const store = Store.fromEnv({ TUNNEL_HOME: home });
    store.saveTunnel({
      name: 't',
      id: 't_1',
      relay: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      key: secretToken(),
      memberId: 'm_1',
      memberToken: secretToken(),
      me: 'claude@laptop',
      cursor: 0,
      files: {},
    });
    store.setCurrent('t');
    mock.timers.enable({ apis: ['Date'] }); // only the clock: fetch and AbortSignal.timeout keep real timers
    try {
      const r = await cli({ TUNNEL_HOME: home }, 'wait', ...flags);
      return { polls, ...r };
    } finally {
      mock.timers.reset();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }

  test('without --timeout, the wait lasts 90 seconds in long polls of at most 50', async () => {
    const r = await pollsOf();
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.polls, [50, 40]);
    assert.match(r.out, /No new messages after 90s/);
  });

  test('--timeout still sets the wait', async () => {
    const r = await pollsOf('--timeout', '5');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.polls, [5]);
    assert.match(r.out, /No new messages after 5s/);
  });
});

describe('skill text', () => {
  const skill = readFileSync(new URL('../skills/tunnel/SKILL.md', import.meta.url), 'utf8');

  test('keeps its front matter first, with LF line endings', () => {
    assert.match(skill, /^---\nname: tunnel\ndescription: /);
    assert.doesNotMatch(skill, /\r/);
  });

  test('tells agents how to wait in any harness, and about the update hint', () => {
    assert.match(skill, /tunnel wait`\. It returns as soon as a message arrives, or after 90 seconds/);
    assert.match(skill, /Run `tunnel update` only when they ask/);
    assert.match(skill, /network_access/);
    assert.doesNotMatch(skill, /--timeout 300/);
  });
});

const SKILL = readFileSync(new URL('../skills/tunnel/SKILL.md', import.meta.url), 'utf8');
const skillFile = (home: string, ...folder: string[]) => join(home, ...folder, 'tunnel', 'SKILL.md');

/** `tunnel skills install …` against a fake home folder. */
function install(home: string, args: string[] = [], env: Record<string, string> = {}) {
  return cli({ TUNNEL_SKILLS_HOME: home, ...env }, 'skills', 'install', ...args);
}

describe('skills install', () => {
  test('with no agent found, writes only the shared folder', async () => {
    const home = tmp('skills-empty');
    const r = await install(home);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(skillFile(home, '.agents', 'skills'), 'utf8'), SKILL);
    assert.equal(existsSync(join(home, '.claude')), false);
    assert.equal(r.out, 'Installed the tunnel skill:\n  ~/.agents/skills/tunnel   agents that read ~/.agents/skills\n');
  });

  test('writes the folders of the agents it finds and names them', async () => {
    const home = tmp('skills-found');
    for (const marker of ['.claude', '.kiro', join('.config', 'opencode')]) mkdirSync(join(home, marker), { recursive: true });
    const r = await install(home);
    assert.equal(r.code, 0, r.err);
    for (const folder of [['.agents', 'skills'], ['.claude', 'skills'], ['.kiro', 'skills']]) {
      assert.equal(readFileSync(skillFile(home, ...folder), 'utf8'), SKILL);
    }
    assert.equal(existsSync(join(home, '.continue')), false);
    assert.equal(
      r.out,
      'Installed the tunnel skill:\n' +
        '  ~/.agents/skills/tunnel   OpenCode, and other agents that read ~/.agents/skills\n' +
        '  ~/.claude/skills/tunnel   Claude Code\n' +
        '  ~/.kiro/skills/tunnel     Kiro\n',
    );
  });

  test('--agent writes exactly the folders those agents read', async () => {
    const home = tmp('skills-named');
    const r = await install(home, ['--agent', 'claude']);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(skillFile(home, '.claude', 'skills')));
    assert.equal(existsSync(join(home, '.agents')), false);
    assert.equal(r.out, 'Installed the tunnel skill:\n  ~/.claude/skills/tunnel   Claude Code\n');

    const both = await install(tmp('skills-named2'), ['--agent', 'kiro,codex']);
    assert.equal(
      both.out,
      'Installed the tunnel skill:\n  ~/.agents/skills/tunnel   Codex\n  ~/.kiro/skills/tunnel     Kiro\n',
    );
  });

  test('--claude and --codex still work, as --agent claude and --agent codex', async () => {
    const home = tmp('skills-alias');
    const r = await install(home, ['--codex']);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(skillFile(home, '.agents', 'skills')));
    assert.equal(existsSync(join(home, '.claude')), false);
    const c = await install(home, ['--claude']);
    assert.equal(c.code, 0, c.err);
    assert.ok(existsSync(skillFile(home, '.claude', 'skills')));
  });

  test('an unknown agent is a usage error that lists the names', async () => {
    const r = await install(tmp('skills-unknown'), ['--agent', 'nope']);
    assert.equal(r.code, 2);
    assert.match(r.err, /^Unknown agent "nope"\. Known agents: claude, codex, cursor, gemini, opencode, copilot,/);
  });

  test('--all writes every folder, and COPILOT_HOME adds its own', async () => {
    const home = tmp('skills-all');
    const copilotHome = join(home, 'copilot-home');
    const r = await install(home, ['--all'], { COPILOT_HOME: copilotHome });
    assert.equal(r.code, 0, r.err);
    for (const folder of [
      ['.agents', 'skills'],
      ['.claude', 'skills'],
      ['copilot-home', 'skills'],
      ['.kiro', 'skills'],
      ['.gemini', 'antigravity-cli', 'skills'],
      ['.continue', 'skills'],
      ['.hermes', 'skills'],
      ['.letta', 'skills'],
    ]) {
      assert.ok(existsSync(skillFile(home, ...folder)), folder.join('/'));
    }
  });

  test('--agent copilot with COPILOT_HOME writes the shared folder and COPILOT_HOME/skills', async () => {
    const home = tmp('skills-copilot');
    const r = await install(home, ['--agent', 'copilot'], { COPILOT_HOME: join(home, 'ch') });
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(skillFile(home, '.agents', 'skills')));
    assert.ok(existsSync(skillFile(home, 'ch', 'skills')));
  });

  test('flags that pick targets are one at a time', async () => {
    const r = await install(tmp('skills-mixed'), ['--all', '--agent', 'claude']);
    assert.equal(r.code, 2);
    assert.match(r.err, /one of --agent, --all and --refresh/);
  });

  test('--refresh rewrites only tunnel skills that are already there', async () => {
    const home = tmp('skills-refresh');
    const put = (text: string, ...folder: string[]) => {
      mkdirSync(join(home, ...folder, 'tunnel'), { recursive: true });
      writeFileSync(skillFile(home, ...folder), text);
    };
    put('---\nname: tunnel\ndescription: old\n---\nold\n', '.claude', 'skills');
    put('---\r\nname: tunnel\r\ndescription: old\r\n---\r\nold\r\n', '.kiro', 'skills');
    const unrelated = '---\nname: other\ndescription: not ours\n---\n';
    put(unrelated, '.continue', 'skills');
    const r = await install(home, ['--refresh']);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(skillFile(home, '.claude', 'skills'), 'utf8'), SKILL);
    assert.equal(readFileSync(skillFile(home, '.kiro', 'skills'), 'utf8'), SKILL);
    assert.equal(readFileSync(skillFile(home, '.continue', 'skills'), 'utf8'), unrelated);
    assert.equal(existsSync(join(home, '.agents')), false);
    assert.equal(
      r.out,
      'Refreshed the tunnel skill:\n  ~/.claude/skills/tunnel   Claude Code\n  ~/.kiro/skills/tunnel     Kiro\n',
    );
  });

  test('--refresh with nothing installed says so and creates nothing', async () => {
    const home = tmp('skills-refresh-none');
    const r = await install(home, ['--refresh']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'No installed tunnel skills to refresh.\n');
    assert.equal(existsSync(join(home, '.agents')), false);
  });

  test('--json lists each folder written with the agents it names', async () => {
    const home = tmp('skills-json');
    mkdirSync(join(home, '.claude'));
    const r = await install(home, ['--json']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), {
      installed: [
        { dir: join(home, '.agents', 'skills', 'tunnel'), agents: [] },
        { dir: join(home, '.claude', 'skills', 'tunnel'), agents: ['Claude Code'] },
      ],
    });
  });

  test('a marker that is a file gives a readable error, not a crash', async () => {
    const home = tmp('skills-file');
    writeFileSync(join(home, '.claude'), 'not a folder');
    const r = await install(home);
    assert.equal(r.code, 1);
    assert.match(r.err, /^Couldn't write .*SKILL\.md: /);
    assert.ok(existsSync(skillFile(home, '.agents', 'skills')));
  });
});
