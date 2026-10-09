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
