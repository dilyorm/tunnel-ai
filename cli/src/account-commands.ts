import { relayFor, sleep, withDevice, type Ctx } from './commands.js';
import { TunnelError, UsageError } from './errors.js';
import { RelayClient } from './relay-client.js';
import { formatBytes, PLANS, planNamed, PRICES, title, type Limits, type PlanName } from './relay/plans.js';

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
