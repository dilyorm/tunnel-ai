import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Features } from '../config.js';
import { BillingError, type BillingProvider, type PaidPlan } from './index.js';

// Lemon Squeezy, the merchant of record: it sells the subscription, charges tax and sends invoices.
// Its API is JSON:API. Webhooks are signed with an HMAC of the raw body in X-Signature.

const API = 'https://api.lemonsqueezy.com/v1';

const EVENTS = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_resumed',
  'subscription_expired',
  'subscription_paused',
  'subscription_unpaused',
]);

/** Statuses where the customer has what they paid for. "cancelled" also counts until ends_at. */
const ACTIVE = new Set(['on_trial', 'active', 'past_due']);

/** A link we can hand to a customer. Lemon Squeezy serves its pages over https; anything else is a broken reply. */
function pageLink(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.startsWith('https://')) throw new Error(`Lemon Squeezy sent no ${what} link`);
  return value;
}

// A word that holds an at-sign. It may only start where a word starts (after a space, an at-sign or the
// start), so on a long text with no spaces the scan stays linear instead of retrying from every letter.
const EMAIL = /(?<![^\s@])[^\s@]+@[^\s@]+/g;

/**
 * The first error's explanation from a JSON:API error reply, on one short line, for the log. It is the
 * provider's free text and can quote the customer's email, so emails (and our API key, should it ever
 * be echoed) are blanked out first; the length cap comes after, so it can't cut a secret in half.
 */
async function detailOf(res: Response, apiKey: string): Promise<string | undefined> {
  try {
    const detail = ((await res.json()) as { errors?: { detail?: unknown }[] }).errors?.[0]?.detail;
    if (typeof detail !== 'string') return undefined;
    const text = detail.replace(/\s+/g, ' ').trim();
    const line = (apiKey ? text.split(apiKey).join('[key]') : text).replace(EMAIL, '[email]');
    return line ? line.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

export function lemonSqueezy(
  config: NonNullable<Features['billing']>,
  publicUrl: string,
  fetcher: typeof fetch,
): BillingProvider {
  const planOf = (variantId: unknown): PaidPlan | null => {
    const id = String(variantId);
    if (id === config.variants.plus) return 'plus';
    if (id === config.variants.pro) return 'pro';
    return null;
  };

  const time = (value: unknown) => (typeof value === 'string' && value ? Date.parse(value) || null : null);

  async function call<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const res = await fetcher(API + path, {
      method,
      headers: {
        accept: 'application/vnd.api+json',
        'content-type': 'application/vnd.api+json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new BillingError(
        `Lemon Squeezy answered ${res.status} to ${method} ${path.split('/')[1]}`,
        await detailOf(res, config.apiKey),
      );
    }
    return (await res.json()) as T;
  }

  return {
    name: 'lemonsqueezy',

    async checkoutUrl(account, plan) {
      const reply = await call<{ data?: { attributes?: { url?: unknown } } }>('POST', '/checkouts', {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: { email: account.email, custom: { account_id: account.id } },
            product_options: { redirect_url: `${publicUrl}/account?upgraded=1` },
          },
          relationships: {
            store: { data: { type: 'stores', id: config.storeId } },
            variant: { data: { type: 'variants', id: config.variants[plan] } },
          },
        },
      });
      return pageLink(reply?.data?.attributes?.url, 'checkout');
    },

    async portalUrl(subscriptionId) {
      const reply = await call<{ data?: { attributes?: { urls?: { customer_portal?: unknown } } } }>(
        'GET',
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );
      return pageLink(reply?.data?.attributes?.urls?.customer_portal, 'billing portal');
    },

    verify(raw, headers) {
      const given = Buffer.from(String(headers['x-signature'] ?? ''), 'utf8');
      const expected = Buffer.from(createHmac('sha256', config.webhookSecret).update(raw).digest('hex'), 'utf8');
      return given.length === expected.length && timingSafeEqual(given, expected);
    },

    parse(raw) {
      let payload: any;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return undefined;
      }
      const type = payload?.meta?.event_name;
      if (!EVENTS.has(type) || !payload.data?.id) return undefined;
      const attributes = payload.data.attributes ?? {};
      const status = String(attributes.status ?? '');
      const endsAt = time(attributes.ends_at);
      return {
        type,
        accountId: String(payload.meta.custom_data?.account_id ?? ''),
        provider: 'lemonsqueezy',
        subscriptionId: String(payload.data.id),
        plan: planOf(attributes.variant_id),
        status,
        active: ACTIVE.has(status) || (status === 'cancelled' && endsAt !== null),
        renewsAt: time(attributes.renews_at),
        endsAt,
        updatedAt: time(attributes.updated_at) ?? Date.now(),
      };
    },
  };
}
