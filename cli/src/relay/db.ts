import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// node:sqlite still prints an ExperimentalWarning on Node 22. Silence that one warning only.
async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite')) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

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

export interface Member {
  id: string;
  tunnel_id: string;
  profile: string | null;
  created: number;
  seen: number;
}

export interface Tunnel {
  id: string;
  owner_device: string;
  owner_member: string;
  seq: number;
}

export interface Invite {
  slot: number;
  tunnel_id: string;
  salt: string;
  wrapped: string;
  verifier_hash: string;
  attempts: number;
  expires: number;
}

export interface MessageRow {
  seq: number;
  member_id: string;
  ct: string;
  created: number;
}

export type Store = Awaited<ReturnType<typeof openStore>>;

export async function openStore(dataDir: string) {
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  const { DatabaseSync } = await loadSqlite();
  const db: DatabaseSyncType = new DatabaseSync(join(dataDir, 'relay.db'));
  db.exec(SCHEMA);
  for (const [table, column, type] of COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec(AFTER_COLUMNS);

  const q = <T>(sql: string) => {
    const stmt = db.prepare(sql);
    return {
      get: (...args: (string | number | null)[]) => stmt.get(...args) as T | undefined,
      all: (...args: (string | number | null)[]) => stmt.all(...args) as T[],
      run: (...args: (string | number | null)[]) => stmt.run(...args),
    };
  };

  const s = {
    deviceByToken: q<Device>('SELECT id, account_id, seen FROM devices WHERE token_hash = ?'),
    insertDevice: q('INSERT INTO devices (id, token_hash, created) VALUES (?, ?, ?)'),
    touchDevice: q('UPDATE devices SET seen = ? WHERE id = ?'),

    tunnel: q<Tunnel>('SELECT id, owner_device, owner_member, seq FROM tunnels WHERE id = ?'),
    countTunnels: q<{ n: number }>('SELECT COUNT(*) AS n FROM tunnels WHERE owner_device = ?'),
    insertTunnel: q(
      'INSERT INTO tunnels (id, owner_device, owner_member, seq, created) VALUES (?, ?, ?, 0, ?)',
    ),
    bumpSeq: q<{ seq: number }>('UPDATE tunnels SET seq = seq + 1 WHERE id = ? RETURNING seq'),
    deleteTunnel: q('DELETE FROM tunnels WHERE id = ?'),

    memberByToken: q<Member>(
      'SELECT id, tunnel_id, profile, created, seen FROM members WHERE token_hash = ?',
    ),
    members: q<Member>(
      'SELECT id, tunnel_id, profile, created, seen FROM members WHERE tunnel_id = ? ORDER BY created',
    ),
    insertMember: q(
      'INSERT INTO members (id, tunnel_id, token_hash, profile, created, seen) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    setProfile: q('UPDATE members SET profile = ? WHERE id = ?'),
    touchMember: q('UPDATE members SET seen = ? WHERE id = ?'),
    deleteMember: q('DELETE FROM members WHERE id = ?'),
    countMembers: q<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE tunnel_id = ?'),

    insertMessage: q(
      'INSERT INTO messages (tunnel_id, seq, member_id, ct, created) VALUES (?, ?, ?, ?, ?)',
    ),
    messagesAfter: q<MessageRow>(
      'SELECT seq, member_id, ct, created FROM messages WHERE tunnel_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ),

    invite: q<Invite>('SELECT * FROM invites WHERE slot = ? AND expires > ?'),
    usedSlots: q<{ slot: number }>('SELECT slot FROM invites'),
    insertInvite: q(
      'INSERT INTO invites (slot, tunnel_id, salt, wrapped, verifier_hash, attempts, expires) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ),
    failInvite: q<{ attempts: number }>(
      'UPDATE invites SET attempts = attempts + 1 WHERE slot = ? RETURNING attempts',
    ),
    deleteInvite: q('DELETE FROM invites WHERE slot = ?'),

    insertFile: q('INSERT INTO files (id, tunnel_id, member_id, size, created) VALUES (?, ?, ?, ?, ?)'),
    file: q<{ id: string; tunnel_id: string }>('SELECT id, tunnel_id FROM files WHERE id = ?'),
    tunnelFiles: q<{ id: string }>('SELECT id FROM files WHERE tunnel_id = ?'),
    oldFiles: q<{ id: string }>('SELECT id FROM files WHERE created < ?'),
    deleteOldFiles: q('DELETE FROM files WHERE created < ?'),
    deleteOldMessages: q('DELETE FROM messages WHERE created < ?'),
    deleteExpiredInvites: q('DELETE FROM invites WHERE expires <= ?'),
  };

  return { db, prepare: q, ...s, close: () => db.close() };
}
