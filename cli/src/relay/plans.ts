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
