import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TunnelError } from './errors.js';

// Local state lives in ~/.tunnel (or $TUNNEL_HOME). Tunnel keys never leave this folder.

export interface TunnelRecord {
  /** Local name, e.g. "api-work". Unique on this machine. */
  name: string;
  id: string;
  relay: string;
  /** Tunnel key, base64url. */
  key: string;
  memberId: string;
  memberToken: string;
  /** This agent's name inside the tunnel, e.g. "claude@laptop". */
  me: string;
  /** Last message seq this agent has read. */
  cursor: number;
  /** Files seen in messages, so `tunnel get <id>` knows their names. */
  files: Record<string, { name: string; size: number }>;
}

export interface Config {
  current?: string;
  relay?: string;
  devices: Record<string, { id: string; token: string }>;
}

export class Store {
  constructor(readonly dir: string) {}

  static fromEnv(env: NodeJS.ProcessEnv) {
    return new Store(env.TUNNEL_HOME || join(homedir(), '.tunnel'));
  }

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw new TunnelError(`Can't read ${join(this.dir, file)}: ${(error as Error).message}`);
    }
  }

  private write(file: string, data: unknown) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, file);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  }

  config(): Config {
    return { devices: {}, ...this.read<Partial<Config>>('config.json', {}) };
  }

  saveConfig(config: Config) {
    this.write('config.json', config);
  }

  tunnels(): Record<string, TunnelRecord> {
    return this.read('tunnels.json', {});
  }

  saveTunnel(record: TunnelRecord) {
    const all = this.tunnels();
    all[record.name] = record;
    this.write('tunnels.json', all);
  }

  removeTunnel(name: string) {
    const all = this.tunnels();
    delete all[name];
    this.write('tunnels.json', all);
    const config = this.config();
    if (config.current === name) {
      config.current = Object.keys(all)[0];
      this.saveConfig(config);
    }
  }

  setCurrent(name: string) {
    const config = this.config();
    config.current = name;
    this.saveConfig(config);
  }

  /** The named tunnel, or the current one. */
  tunnel(name?: string): TunnelRecord {
    const all = this.tunnels();
    const wanted = name ?? this.config().current;
    if (wanted && all[wanted]) return all[wanted];
    if (name) {
      const known = Object.keys(all);
      throw new TunnelError(
        `No tunnel named "${name}" on this machine.` +
          (known.length ? ` Known tunnels: ${known.join(', ')}.` : ' Run `tunnel open` or `tunnel join <code>`.'),
      );
    }
    throw new TunnelError('Not in a tunnel yet. Run `tunnel open` to start one, or `tunnel join <code>`.');
  }

  uniqueName(base: string): string {
    const all = this.tunnels();
    if (!all[base]) return base;
    for (let i = 2; ; i++) if (!all[`${base}-${i}`]) return `${base}-${i}`;
  }
}
