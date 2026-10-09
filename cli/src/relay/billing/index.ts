import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Accounts } from '../accounts.js';
import type { Account, Store } from '../db.js';
import { HttpError, LIMITS, body, json, send } from '../http.js';
import { RANK, planNamed, type PlanName } from '../plans.js';
import type { App } from '../server.js';

// Subscriptions, whoever sells them. The provider adapter turns its webhooks into BillingEvents;
// everything else (checkout guard, dedupe, ordering, the account's plan) lives here.

export type PaidPlan = 'plus' | 'pro';

export interface BillingEvent {
  /** The provider's event name, for the log. */
  type: string;
  accountId: string;
  provider: string;
  subscriptionId: string;
  /** null when the product isn't one of our plans. */
  plan: PaidPlan | null;
  /** The provider's status, verbatim. */
  status: string;
  /** Whether the customer has the plan now (a cancelled plan still runs until endsAt). */
  active: boolean;
  renewsAt: number | null;
  endsAt: number | null;
  /** When the provider last changed the subscription. Older events never overwrite newer ones. */
  updatedAt: number;
}

export interface BillingProvider {
  name: string;
  checkoutUrl(account: Account, plan: PaidPlan): Promise<string>;
  /** Portal links expire, so one is fetched each time someone opens Manage billing. */
  portalUrl(subscriptionId: string): Promise<string>;
  /** Whether the webhook body was signed with our secret. */
  verify(raw: Buffer, headers: IncomingHttpHeaders): boolean;
  /** Our view of a webhook, or undefined for events we don't act on. */
  parse(raw: Buffer): BillingEvent | undefined;
}

/** A failed call to the provider. `detail` is the provider's own explanation, kept short for the log. */
export class BillingError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface SubscriptionView {
  plan: PaidPlan;
  status: string;
  renewsAt: number | null;
  endsAt: number | null;
}

export interface Billing {
  /** The subscription giving this account its plan now, if any. */
  subscriptionOf(accountId: string): SubscriptionView | null;
}

export interface Recompute {
  /** Set the account's plan: a running admin grant wins, then the best live subscription, then Free. */
  account(accountId: string): void;
  /** Recompute every account whose admin grant or subscription has just run out. */
  due(): void;
}

const DAY = 24 * 60 * 60 * 1000;
const LIVE = 'active = 1 AND (ends_at IS NULL OR ends_at > ?)';

export function createRecompute(store: Store): Recompute {
  const s = {
    account: store.prepare<{ plan_source: string | null; plan_until: number | null }>(
      'SELECT plan_source, plan_until FROM accounts WHERE id = ?',
    ),
    live: store.prepare<{ plan: PaidPlan }>(`SELECT plan FROM subscriptions WHERE account_id = ? AND ${LIVE}`),
    set: store.prepare('UPDATE accounts SET plan = ?, plan_source = ?, plan_until = NULL WHERE id = ?'),
    endedGrants: store.prepare<{ id: string }>(
      "SELECT id FROM accounts WHERE plan_source = 'admin' AND plan_until IS NOT NULL AND plan_until <= ?",
    ),
    endedSubscriptions: store.prepare<{ account_id: string }>(
      'UPDATE subscriptions SET active = 0 WHERE active = 1 AND ends_at IS NOT NULL AND ends_at <= ? RETURNING account_id',
    ),
  };

  const recompute: Recompute = {
    account(accountId) {
      const now = Date.now();
      const row = s.account.get(accountId);
      if (!row) return;
      if (row.plan_source === 'admin' && (row.plan_until === null || row.plan_until > now)) return;
      let best: PlanName = 'free';
      for (const sub of s.live.all(accountId, now)) if (RANK[sub.plan] > RANK[best]) best = sub.plan;
      s.set.run(best, best === 'free' ? null : 'billing', accountId);
    },
    due() {
      const now = Date.now();
      const ids = new Set([
        ...s.endedGrants.all(now).map((row) => row.id),
        ...s.endedSubscriptions.all(now).map((row) => row.account_id),
      ]);
      for (const id of ids) recompute.account(id);
    },
  };
  return recompute;
}

export function billingRoutes(app: App, accounts: Accounts, provider: BillingProvider, recompute: Recompute): Billing {
  const { store } = app;
  const s = {
    live: store.prepare<{ plan: PaidPlan; status: string; renews_at: number | null; ends_at: number | null }>(
      `SELECT plan, status, renews_at, ends_at FROM subscriptions
        WHERE account_id = ? AND ${LIVE} ORDER BY updated DESC LIMIT 1`,
    ),
    // A live subscription first (it is the one the customer can still change), else the newest.
    portal: store.prepare<{ provider_id: string }>(
      `SELECT provider_id FROM subscriptions WHERE account_id = ? AND provider = ?
        ORDER BY (${LIVE}) DESC, updated DESC LIMIT 1`,
    ),
    seen: store.prepare<{ id: string }>('SELECT id FROM billing_events WHERE id = ?'),
    remember: store.prepare('INSERT OR IGNORE INTO billing_events (id, received) VALUES (?, ?)'),
    hasAccount: store.prepare<{ id: string }>('SELECT id FROM accounts WHERE id = ?'),
    tracked: store.prepare<{ account_id: string }>(
      'SELECT account_id FROM subscriptions WHERE provider = ? AND provider_id = ?',
    ),
    // Same ordering guard as the upsert: an event older than the stored row changes nothing.
    // The plan column stays as it was; the row just stops counting as live.
    retire: store.prepare(
      `UPDATE subscriptions SET status = ?, active = 0, renews_at = ?, ends_at = ?, updated = ?
        WHERE provider = ? AND provider_id = ? AND updated <= ?`,
    ),
    // The WHERE makes an event older than the stored row a no-op (changes = 0).
    upsert: store.prepare(
      `INSERT INTO subscriptions (provider, provider_id, account_id, plan, status, active, renews_at, ends_at, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, provider_id) DO UPDATE SET
         account_id = excluded.account_id, plan = excluded.plan, status = excluded.status,
         active = excluded.active, renews_at = excluded.renews_at, ends_at = excluded.ends_at,
         updated = excluded.updated
       WHERE excluded.updated >= subscriptions.updated`,
    ),
    dropEvents: store.prepare('DELETE FROM billing_events WHERE received < ?'),
  };

  // Checkout and Manage billing each call the provider, so one budget covers all three routes.
  // It is keyed by account (by device while a machine has no account) and checked after sign-in,
  // so a caller who is not signed in cannot spend anyone's budget.
  const limitCalls = app.counter(
    10 * 60_000,
    LIMITS.billingCallsPer10Minutes,
    'Too many billing requests. Wait ten minutes and try again.',
  );

  /** An error for the log: its message, plus the provider's own explanation when it sent one. */
  const describe = (error: unknown) => {
    const { message, detail } = error as BillingError;
    return detail ? `${message}: ${detail}` : message;
  };

  async function checkout(account: Account, input: { plan?: unknown }) {
    const plan = planNamed(input.plan);
    if (plan !== 'plus' && plan !== 'pro') throw new HttpError(400, 'Pick a plan: plus or pro.');
    // A second subscription would bill twice. Plan changes go through the provider's portal.
    if (s.live.get(account.id, Date.now())) {
      throw new HttpError(409, 'You already have a subscription. Change plans from Manage billing on your account page.');
    }
    let url: string;
    try {
      url = await provider.checkoutUrl(account, plan);
    } catch (error) {
      app.log(`Checkout failed: ${describe(error)}`);
      throw new HttpError(502, "The payment page didn't load. Try again in a minute.");
    }
    app.stats.count('checkouts');
    return { url };
  }

  app.on('POST', '/v1/account/checkout', async (req, res) => {
    accounts.requireOrigin(req);
    const account = accounts.requireSession(req);
    limitCalls(req, account.id);
    send(res, 200, await checkout(account, await json(req)));
  });

  app.on('POST', '/v1/devices/me/checkout', async (req, res) => {
    const device = app.device(req);
    limitCalls(req, device.account_id ?? device.id);
    const input = await json<{ plan?: unknown }>(req);
    const account = device.account_id ? accounts.byId(device.account_id) : undefined;
    if (!account) throw new HttpError(409, "This machine isn't linked to an account. Run `tunnel login` first.");
    send(res, 200, await checkout(account, input));
  });

  app.on('GET', '/v1/account/portal', async (req, res) => {
    const account = accounts.requireSession(req);
    limitCalls(req, account.id);
    const sub = s.portal.get(account.id, provider.name, Date.now());
    if (!sub) throw new HttpError(404, 'No subscription yet.');
    let url: string;
    try {
      url = await provider.portalUrl(sub.provider_id);
    } catch (error) {
      app.log(`Billing portal failed: ${describe(error)}`);
      throw new HttpError(502, "The billing page didn't load. Try again in a minute.");
    }
    send(res, 200, { url });
  });

  /** What an event does to the stored subscriptions and the account's plan. Runs inside apply's transaction. */
  function place(event: BillingEvent): { outcome: string; changed: boolean } {
    const skip = (outcome: string) => ({ outcome, changed: false });
    if (!event.plan) {
      // Not one of our plans. A subscription we already track that moved to such a product no longer
      // gives a plan: end it, or a customer who switched to it and cancelled would keep their old plan.
      const known = s.tracked.get(provider.name, event.subscriptionId);
      if (!known) return skip('not a tunnel plan, skipped');
      const changes = s.retire.run(
        event.status,
        event.renewsAt,
        event.endsAt,
        event.updatedAt,
        provider.name,
        event.subscriptionId,
        event.updatedAt,
      ).changes;
      if (Number(changes) === 0) return skip('older than what we have, skipped');
      recompute.account(known.account_id);
      return { outcome: 'not a tunnel plan, subscription ended', changed: true };
    }
    if (!s.hasAccount.get(event.accountId)) return skip('unknown account, skipped');
    const changes = s.upsert.run(
      provider.name,
      event.subscriptionId,
      event.accountId,
      event.plan,
      event.status,
      event.active ? 1 : 0,
      event.renewsAt,
      event.endsAt,
      event.updatedAt,
    ).changes;
    if (Number(changes) === 0) return skip('older than what we have, skipped');
    recompute.account(event.accountId);
    return { outcome: 'applied', changed: true };
  }

  /** Store the event and update the account. Returns what happened, for the log. */
  function apply(raw: Buffer, event: BillingEvent): string {
    const id = createHash('sha256').update(raw).digest('hex');
    store.db.exec('BEGIN IMMEDIATE');
    try {
      let outcome: string;
      if (s.seen.get(id)) outcome = 'duplicate, skipped';
      else {
        const placed = place(event);
        // Only an event that changed something is remembered. A skipped one may become valid once the
        // owner fixes a mistake (a variant id, say), and the provider's resend must not read as a duplicate.
        if (placed.changed) s.remember.run(id, Date.now());
        outcome = placed.outcome;
      }
      store.db.exec('COMMIT');
      return outcome;
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
  }

  // 400 makes the provider retry; everything else gets 200 so it stops. Bodies are never logged.
  app.on('POST', '/v1/billing/webhook', async (req, res) => {
    const raw = await body(req, 1024 * 1024);
    if (!provider.verify(raw, req.headers)) throw new HttpError(400, 'Bad signature.');
    const event = provider.parse(raw);
    if (event) {
      const outcome = apply(raw, event);
      app.log(`Billing ${event.type} (${event.status}) for ${event.accountId || 'no account'}: ${outcome}.`);
    }
    send(res, 200, { ok: true });
  });

  app.sweeps.push(() => {
    s.dropEvents.run(Date.now() - 90 * DAY);
  });

  return {
    subscriptionOf(accountId) {
      const row = s.live.get(accountId, Date.now());
      return row ? { plan: row.plan, status: row.status, renewsAt: row.renews_at, endsAt: row.ends_at } : null;
    },
  };
}
