import { createHmac } from 'node:crypto';
import { createServer, request } from 'node:http';
import { pipeline } from 'node:stream';
import { startRelay } from '../src/relay/server.js';

// A relay for working on the site, with every feature on and the outside services faked:
// sign-in emails are printed here instead of sent, and checkout "pays" at once by sending this
// relay a signed webhook. Run `npm run dev-relay`, then the site's dev server on port 5173.
// Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET from a dev OAuth app to try GitHub sign-in too.
// Set NO_BILLING=1 to leave billing off, as a first production relay may, and see the page without it.

const SITE = 'http://localhost:5173';
const PORT = 8787;
const SECRET = 'dev-webhook-secret';
const DAY = 24 * 60 * 60 * 1000;

const env = {
  TUNNEL_PUBLIC_URL: SITE,
  RESEND_API_KEY: 'dev',
  TUNNEL_EMAIL_FROM: 'tunnel <login@localhost>',
  ...(process.env.NO_BILLING
    ? {}
    : {
        LEMONSQUEEZY_API_KEY: 'dev',
        LEMONSQUEEZY_STORE_ID: '1',
        LEMONSQUEEZY_WEBHOOK_SECRET: SECRET,
        LEMONSQUEEZY_VARIANT_PLUS: '1001',
        LEMONSQUEEZY_VARIANT_PRO: '1002',
      }),
  TUNNEL_ADMIN_EMAILS: 'dev@example.com',
  TUNNEL_STATS_SALT: 'dev',
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
};

/** What Lemon Squeezy would send once a checkout is paid. */
async function paid(accountId: string, variantId: string) {
  const raw = JSON.stringify({
    meta: { event_name: 'subscription_created', custom_data: { account_id: accountId } },
    data: {
      type: 'subscriptions',
      id: `sub_dev_${Date.now()}`,
      attributes: {
        variant_id: Number(variantId),
        status: 'active',
        renews_at: new Date(Date.now() + 30 * DAY).toISOString(),
        ends_at: null,
        updated_at: new Date().toISOString(),
      },
    },
  });
  await fetch(`${relay.url}/v1/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', SECRET).update(raw).digest('hex') },
    body: raw,
  });
}

// The relay only passes on payment links that start with https://, and this site is plain http. So the
// fake answers with this stand-in address, and the front door below swaps it for the site's own.
const STAND_IN = 'https://dev.invalid';

const fake = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
  if (url === 'https://api.resend.com/emails') {
    console.log(`\nSign-in link for ${body.to.join(', ')}:\n${/https?:\/\/\S+/.exec(body.text)?.[0]}\n`);
    return Response.json({ id: 'dev' });
  }
  if (url === 'https://api.lemonsqueezy.com/v1/checkouts') {
    await paid(body.data.attributes.checkout_data.custom.account_id, body.data.relationships.variant.data.id);
    return Response.json({ data: { attributes: { url: `${STAND_IN}/account?upgraded=1` } } });
  }
  if (url.startsWith('https://api.lemonsqueezy.com/v1/subscriptions/')) {
    return Response.json({ data: { attributes: { urls: { customer_portal: `${STAND_IN}/account` } } } });
  }
  return globalThis.fetch(input, init);
}) as typeof fetch;

const relay = await startRelay({
  port: 0,
  host: '127.0.0.1',
  dataDir: 'dev-data',
  env,
  fetch: fake,
  maxTunnelsPerDevice: 1,
  linkPollSeconds: 1,
});

// The front door on PORT, which the site's dev server and the CLI talk to. It passes everything through
// to the relay, except that the two replies carrying a payment link get the site's address in place of
// the stand-in, so "Get Plus" and "Manage billing" land back on the account page.
const inside = new URL(relay.url);
const WITH_LINK = new Set(['/v1/account/checkout', '/v1/account/portal']);

createServer((req, res) => {
  const forward = request(
    { host: inside.hostname, port: inside.port, method: req.method, path: req.url, headers: req.headers },
    (reply) => {
      if (!WITH_LINK.has(req.url ?? '') || reply.statusCode !== 200) {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      reply.on('data', (chunk: Buffer) => chunks.push(chunk));
      reply.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').replace(STAND_IN, SITE);
        const { 'transfer-encoding': _chunked, ...headers } = reply.headers;
        res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(text) });
        res.end(text);
      });
    },
  );
  forward.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  pipeline(req, forward, () => {});
}).listen(PORT, '127.0.0.1');

console.log(`Dev relay on http://127.0.0.1:${PORT}. Open ${SITE}/account and sign in as dev@example.com to see the admin page too.`);
console.log(`Point the CLI at it with TUNNEL_RELAY=http://127.0.0.1:${PORT}`);
