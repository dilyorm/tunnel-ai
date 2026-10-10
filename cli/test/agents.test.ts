import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { CODEX_NETWORK_HINT, run } from '../src/cli.js';
import { TunnelError, UnreachableError } from '../src/errors.js';
import { RelayClient } from '../src/relay-client.js';
import { tmp } from './helpers.js';

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
