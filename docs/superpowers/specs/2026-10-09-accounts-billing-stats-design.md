# Accounts, billing, stats and admin: design

Date: 2026-10-09 · Status: approved in chat, awaiting spec review.
This spec covers sub-project C from `2026-10-06-tunnel-ai-design.md`. It replaces the earlier trial idea and the "pay as you go per tunnel" plan.

## Goal

- Anyone can keep using tunnel without an account, as today.
- People who want more can sign in and pay a flat monthly price for higher limits.
- The owner (Dilyorbek) gets one admin page with the numbers that matter: messages per day, installs, active users and landing views.
- The landing page tells visitors they can just ask their agent to install tunnel.

**Out of scope:** team seats, metered billing, coupons, our own invoice pages (the payment provider sends invoices), and any email other than the sign-in link.

## Decisions (from the 2026-10-08/09 discussion)

| Question | Decision |
|---|---|
| Architecture | Extend the existing relay process: same Node server, same SQLite, still zero runtime dependencies. Every new feature stays off unless its environment variables are set. |
| Anonymous users | Unchanged: 1 tunnel per machine. |
| Signed-in free users | Same limits as anonymous. Signing in adds the account page, machine linking, and the ability to pay. |
| Paid plans | Flat monthly. **Plus $5**, **Pro $9**. |
| Sign-in | GitHub OAuth and email magic link. Email goes out through Resend. |
| Payment provider | **Lemon Squeezy** (merchant of record). Stripe can't pay out to an individual in Uzbekistan. The provider sits behind one interface so Paddle can replace it. |
| Analytics | Our own cookieless counters. No third-party analytics and no consent banner. |
| Agent install | One line under the install box. No separate `/agents` page. |

## Plans and limits

| | Free (anonymous or signed in) | Plus, $5/mo | Pro, $9/mo |
|---|---|---|---|
| Tunnels | 1 per machine | 10 per account | 20 per account |
| File size | 10 MB | 50 MB | 100 MB |
| Message and file history | 7 days | 30 days | 30 days |
| File storage | none beyond the file limit | 2 GB per account | 5 GB per account |

`relay/plans.ts` is the single source for these numbers:

```ts
export const PLANS = {
  free: { tunnels: 1, perDevice: true,  fileBytes: 10 * MB,  historyDays: 7,  storageBytes: 0 },
  plus: { tunnels: 10, perDevice: false, fileBytes: 50 * MB,  historyDays: 30, storageBytes: 2 * GB },
  pro:  { tunnels: 20, perDevice: false, fileBytes: 100 * MB, historyDays: 30, storageBytes: 5 * GB },
} as const;
```

**Which plan applies.** A tunnel's plan is the current plan of the account linked to the device that owns the tunnel (`tunnels.owner_device → devices.account_id → accounts.plan`). A tunnel with no linked account is on the free plan. Every member of a Pro owner's tunnel gets Pro file sizes and history. `storageBytes: 0` means no account-wide storage check, which is today's free behaviour; the file-size limit and the 7-day expiry bound it.

**Opening a tunnel**
- On the free plan, count the tunnels owned by this device. The cap is `TUNNEL_MAX_TUNNELS`: 1 on the hosted relay, 0 (unlimited) when self-hosted, exactly as today.
- On a paid plan, count the tunnels owned by every device linked to the account and compare with `plan.tunnels`.
- Over the limit, return 403 with a message that names the plan and the next step. For example: "The free plan allows 1 tunnel per machine. Close one with `tunnel close`, or run `tunnel upgrade` for 10 or 20."

**Uploading a file**
- Reject on `Content-Length` before reading the body if it's over `plan.fileBytes`. The body reader's maximum is also `plan.fileBytes`.
- On a paid plan, reject if the account's stored bytes plus the new file would exceed `plan.storageBytes`. Stored bytes means `SUM(files.size)` over tunnels owned by the account's devices.
- Both rejections return 413 with the limit and an upgrade hint.

**History.** Messages and files get an `expires` value when they're inserted: `now + plan.historyDays`. The sweep deletes by `expires`, which replaces the global cutoff based on `created`. A migration sets `expires = created + 7 days` on existing rows.

**Downgrade.** When a subscription ends, the account goes back to free.
- Existing tunnels, messages and files stay until they expire on their stored dates.
- Opening new tunnels follows the free rule.
- Nothing is deleted early.

**Admin override.** The admin can set any account's plan, optionally with an end date. While it's set, it wins over billing (`plan_source = 'admin'`).

**nginx.** Raise `client_max_body_size` to `101m` for `/v1/`. Uploads are already given a timeout that scales with size, and the relay is still what enforces each plan's limit.

## Data model (SQLite, additive migrations)

Migrations run at startup and are idempotent. New tables use `CREATE TABLE IF NOT EXISTS`. Columns are added only after a `PRAGMA table_info` check.

```sql
-- accounts and sessions
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,          -- lowercased, verified
  github_id INTEGER UNIQUE,
  github_login TEXT,
  plan TEXT NOT NULL DEFAULT 'free',   -- free | plus | pro (effective plan)
  plan_source TEXT,                    -- billing | admin | NULL
  plan_until INTEGER,                  -- admin grants: when the override ends
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
ALTER TABLE devices ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN seen INTEGER;
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, created INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE email_logins (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, return_to TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, return_to TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE device_links (
  user_code TEXT PRIMARY KEY,          -- shown to the user, e.g. KQ7M-4TXP
  poll_hash TEXT NOT NULL UNIQUE,      -- the CLI polls with this secret
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id TEXT,                     -- set when approved
  expires INTEGER NOT NULL
);

-- billing
CREATE TABLE subscriptions (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,                -- provider status, stored verbatim
  renews_at INTEGER, ends_at INTEGER,
  portal_url TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_id)
);
CREATE TABLE billing_events (id TEXT PRIMARY KEY, received INTEGER NOT NULL);  -- sha256(raw body)

-- plan-aware expiry
ALTER TABLE messages ADD COLUMN expires INTEGER;
ALTER TABLE files ADD COLUMN expires INTEGER;
CREATE INDEX messages_expires ON messages(expires);
CREATE INDEX files_expires ON files(expires);
CREATE INDEX devices_account ON devices(account_id);

-- stats (UTC days, 'YYYY-MM-DD')
CREATE TABLE stats_daily (day TEXT NOT NULL, metric TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric));
CREATE TABLE active_devices (day TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (day, device_id));
CREATE TABLE visitors (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash));
CREATE TABLE referrers (day TEXT NOT NULL, host TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, host));
```

**Retention**
- `visitors` rows are deleted once their day is over. Only the daily unique count survives, in `stats_daily`.
- `active_devices` and `referrers` are kept for 90 days.
- `stats_daily` is kept forever.
- Expired sessions, logins, states and links are swept every 10 minutes along with the existing cleanup.

## Sign-in

**Shared rules**
- Tokens are 32 random bytes. The database stores only their sha256.
- The session cookie is `tunnel_session`: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (30 days). `Secure` is left off only when `TUNNEL_PUBLIC_URL` is plain `http://`, as in local tests.
- Browser POSTs to `/v1/account/*`, `/v1/auth/*` and `/v1/admin/*` must carry an `Origin` equal to `TUNNEL_PUBLIC_URL`. Anything else gets 403.
- `return_to` must be a same-site path: it starts with `/` and not `//`. Anything else falls back to `/account`.
- When one email or GitHub id matches an existing account, it's the same account:
  - GitHub sign-in links by `github_id` first, then by verified primary email.
  - Email sign-in links by email.

**GitHub OAuth**
1. `GET /v1/auth/github/start?return=/account` stores a random state (10 minutes) and redirects to `https://github.com/login/oauth/authorize` with `client_id`, `redirect_uri=${PUBLIC_URL}/v1/auth/github/callback`, `scope=read:user user:email` and `state`.
2. `GET /v1/auth/github/callback?code&state`:
   1. Check the state and use it once.
   2. POST `https://github.com/login/oauth/access_token` (JSON).
   3. GET `https://api.github.com/user` and `/user/emails`. Require a primary, verified email.
   4. Upsert the account and set the session cookie.
   5. Redirect to `return_to`.
3. On failure, redirect to `/account?error=<code>`. The page shows a plain message for each code.

**Email magic link**
1. `POST /v1/auth/email {email, return}` always returns 202, so responses never reveal whether an account exists.
   - Limits: 5 sends per hour per address and 20 per hour per IP, in-memory windows using the same `counter()` helper as today.
   - It stores the token hash with a 15-minute expiry and sends through Resend: `POST https://api.resend.com/emails`, from `TUNNEL_EMAIL_FROM`.
   - The email contains one link: `${PUBLIC_URL}/v1/auth/email/verify?token=…`.
   - If Resend fails, return 502: "Couldn't send the email. Try again or sign in with GitHub."
2. `GET /v1/auth/email/verify?token=` uses the token once, upserts the account by email, sets the cookie, and redirects to `return_to`. An expired or used token redirects to `/account?error=link-expired`.

**Sign out:** `POST /v1/auth/logout` deletes the session row and clears the cookie.

**Linking a machine from the CLI (device-code flow)**
1. `tunnel login` sends `POST /v1/auth/device` with the device bearer token. The relay returns `{userCode, verifyUrl, pollToken, expiresIn: 600, interval: 3}`.
   - `userCode` is 8 characters from an alphabet with no look-alikes, shown as `XXXX-XXXX`.
   - `verifyUrl` is `${PUBLIC_URL}/account?link=XXXX-XXXX`.
2. The CLI prints the code and the URL, and opens the URL in the browser when stdout is a TTY (`start`, `open` or `xdg-open`; failure is ignored).
3. On `/account?link=…` the user signs in if needed, sees "Link this machine? Code XXXX-XXXX", and confirms. That sends `POST /v1/account/devices/link {userCode}`, which sets `device_links.account_id`.
4. The CLI polls `POST /v1/auth/device/poll {pollToken}` every 3 seconds:
   - 202 while pending
   - 200 `{email, plan}` once approved; the relay sets `devices.account_id` and deletes the link
   - 410 once expired
5. `tunnel logout` sends `POST /v1/devices/me/unlink`.
6. The device's bearer token never changes. Linking only attaches the device to an account. Each relay in `config.devices` is linked separately; the commands act on the current relay.

## Billing

```ts
// relay/billing/index.ts
export type PaidPlan = 'plus' | 'pro';
export interface BillingEvent {
  id: string;                 // dedupe key
  accountId: string;
  provider: string;
  subscriptionId: string;
  plan: PaidPlan | null;      // null when the provider's product isn't one of ours
  status: string;             // provider status, verbatim
  active: boolean;            // provider-specific mapping, see below
  renewsAt?: number; endsAt?: number;
  portalUrl?: string;
}
export interface BillingProvider {
  name: string;
  checkoutUrl(account: Account, plan: PaidPlan): Promise<string>;
  verify(raw: Buffer, headers: IncomingHttpHeaders): boolean;
  parse(raw: Buffer): BillingEvent | null;   // null = event we ignore
}
```

**Lemon Squeezy adapter** (`relay/billing/lemonsqueezy.ts`)
- **Checkout:** `POST https://api.lemonsqueezy.com/v1/checkouts` (JSON:API, `Authorization: Bearer LEMONSQUEEZY_API_KEY`), with:
  - the store id
  - the variant for the plan (`LEMONSQUEEZY_VARIANT_PLUS` or `_PRO`)
  - `checkout_data.email` set to the account email
  - `checkout_data.custom.account_id`
  - `product_options.redirect_url = ${PUBLIC_URL}/account?upgraded=1`

  It returns `data.attributes.url`.
- **Webhook check:** the `X-Signature` header is the hex HMAC-SHA256 of the raw body, keyed with `LEMONSQUEEZY_WEBHOOK_SECRET`. Compare with `timingSafeEqual`.
- **Events handled:**
  - `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`, `subscription_expired`, `subscription_paused` and `subscription_unpaused`
  - Everything else returns 200 and is ignored.
  - Fields read: `meta.custom_data.account_id`, `data.id`, `data.attributes.{status, variant_id, renews_at, ends_at, urls.customer_portal}`.
- **What counts as active:**
  - `on_trial`, `active` and `past_due` are active.
  - `cancelled` stays active until `ends_at`.
  - `paused`, `unpaid` and `expired` are not active.
- **Dedupe key:** `sha256(raw body)`.

**Effective plan.** After every webhook, and in the 10-minute sweep, recompute each touched account:
1. An admin override (`plan_source = 'admin'`, `plan_until` not yet passed) wins.
2. Otherwise, take the highest plan among the account's active subscriptions.
3. Otherwise, free.

The result is written to `accounts.plan` and `plan_source`.

**Endpoints**
- `POST /v1/account/checkout {plan}` → `{url}` (session)
- `POST /v1/devices/me/checkout {plan}` → `{url}` (device token; needs a linked account, otherwise 409 "Run `tunnel login` first.")
- `GET /v1/account/portal` → `{url}` from the newest subscription row (404 if there are none)
- `POST /v1/billing/webhook` → 400 on a bad signature; 200 otherwise, including duplicates and ignored events

**Errors.** If the provider fails while creating a checkout, return 502: "The payment page didn't load. Try again in a minute."

**Before launch.** Until the store is approved, Lemon Squeezy runs in test mode, and paid plans can be granted from the admin page.

## Stats

**Counted metrics** (UTC day, rows in `stats_daily`):
- messages: `messages`, `files`, `file_bytes`
- tunnels and devices: `tunnels_opened`, `joins`, `devices_created`
- accounts and billing: `signups`, `logins`, `checkouts`
- page traffic: `page_views`, `unique_visitors`
- installs: `installs_sh`, `installs_ps1`, `installs_npm`

Each increment is one upsert: `INSERT … ON CONFLICT(day, metric) DO UPDATE SET n = n + ?`.

**Active users**
- Every request authenticated with a device token inserts `(day, device_id)` into `active_devices` (insert-or-ignore). An in-memory per-day set skips repeat writes.
- `devices.seen` is updated at most once an hour per device.
- DAU, WAU and MAU are distinct device counts over the last 1, 7 and 30 days.
- Active accounts are the same counts joined through `devices.account_id`.

**Landing views**
- The site sends `navigator.sendBeacon('/v1/hit', JSON.stringify({p: location.pathname, r: document.referrer}))` once per page load. It's sent as `text/plain`, so there's no CORS preflight.
- The relay drops user agents that look like bots (`bot|crawl|spider|slurp|preview|headless`).
- It then increments `page_views` and inserts `hash = sha256(HMAC(TUNNEL_STATS_SALT, day) ‖ ip ‖ ua)` into `visitors`. A new row also increments `unique_visitors`.
- The referrer is reduced to its host and counted only when it's external.
- No cookie is set and no raw IP is stored.

**Installs**
- nginx keeps serving `install.sh`, `install.ps1` and `tunnel-ai.tgz` as static files, and adds `mirror /_count;` to each of those locations.
- The internal mirror location proxies to the relay at `/internal/install?f=$uri` and passes the user agent along.
- The relay route is outside `/v1/`, and nginx only proxies `/v1/` publicly, so only nginx itself can reach it.
- Counting rule: `install.sh` → `installs_sh`, `install.ps1` → `installs_ps1`, and `tunnel-ai.tgz` → `installs_npm` only when the user agent starts with `npm/`. The installers download the tarball with curl or PowerShell, and those requests aren't counted twice.

## Admin

**Access.** You're an admin when your session's account email is in `TUNNEL_ADMIN_EMAILS` (comma-separated, compared lowercased). Everyone else gets 404 from every admin route, so the routes look like they don't exist.

**API**
- `GET /v1/admin/stats?days=30` returns:
  - `{days: [...], series: {metric: number[]}}`
  - today's numbers
  - DAU, WAU and MAU, plus the same for accounts
  - accounts by plan
  - monthly revenue (`plus×5 + pro×9`, counting billing-sourced active plans only)
  - the top 10 referrers over the period
- `GET /v1/admin/accounts?q=&cursor=`: 50 per page, newest first, with email, GitHub login, plan, plan source, linked devices, owned tunnels, created and last seen.
- `POST /v1/admin/accounts/:id/plan {plan, until?}`: sets `plan_source = 'admin'`. `plan: null` clears the override.

**Page (`/admin`)**
- A row of numbers for today.
- 30-day charts for messages, installs (three series), active devices, page views with unique visitors, and sign-ups. The charts are inline SVG with no chart library, built following the dataviz skill at implementation time.
- A top-referrers table.
- The accounts table, with search and a plan selector per row.

## Website

**Vite multi-page.** `index.html`, `account.html`, `admin.html`, `terms.html`, `privacy.html` and `refund.html` go into `build.rollupOptions.input`. nginx serves `/account` as `account.html` through `try_files $uri $uri.html $uri/ =404`. The sitemap lists `/`, `/terms`, `/privacy` and `/refund`. `/account` and `/admin` are `noindex` and disallowed in `robots.txt`.

**Landing changes**
- Under the install box: "Or just tell your agent: *Install tunnel from tunnel.dilyor.dev*", with a copy button that copies that sentence.
- The header nav gets "Sign in" (to `/account`). It shows "Account" when the session cookie looks present.
- Pricing has four cards: Free, Plus $5, Pro $9 and Self-hosted. The trial card is removed. The Plus and Pro buttons go to `/account?plan=plus` or `?plan=pro`, which opens checkout right after sign-in.
- Update every FAQ answer that mentions the trial or pay-as-you-go. The FAQPage JSON-LD follows automatically.
- `SoftwareApplication.offers` lists the three prices.
- `llms.txt` gains a pricing line.
- Each page sends the beacon.

**Account page (`/account`)** has three states:
- **Signed out:** a "Continue with GitHub" button and an email form ("Email me a sign-in link"), each shown only when that method is configured.
- **Signed in:**
  - email and plan
  - tunnel usage (`n of limit`)
  - linked machines, each with an unlink button
  - upgrade buttons for plans above the current one
  - "Manage billing" (portal), shown when a subscription exists
  - Sign out
- **Link mode (`?link=CODE`):** a confirm card on top of the signed-in view.

Status flags (`?upgraded=1`, `?error=…`) show one plain sentence each.

`GET /v1/account` returns `{email, githubLogin, plan, planSource, limits, usage: {tunnels, storageBytes}, devices: [...], subscription}`. It returns 401 when there's no session, and the page renders the signed-out state. `GET /v1/auth/methods` returns `{github: bool, email: bool, billing: bool}`.

**Legal pages.** Drafts of Terms, Privacy and Refund. Lemon Squeezy requires them before it activates a store. Privacy states exactly what the stats collect. These are templates, not legal advice; the owner reviews them.

## CLI

| Command | Does |
|---|---|
| `tunnel login` | Runs the device-code flow above and prints "Linked to you@example.com (free)". |
| `tunnel logout` | Unlinks this machine from its account. Tunnels stay. |
| `tunnel account` | Shows email, plan, limits and usage, or "Not signed in. Run `tunnel login`." |
| `tunnel upgrade [plus\|pro]` | Prints the checkout URL and opens it on a TTY. With no plan given, prints both prices. |

- All four support `--json`.
- The CLI drops any hard-coded file-size check; the relay decides and explains.
- `SKILL.md` gains one rule: if the relay reports a plan limit, tell the user the message word for word. Never run `tunnel upgrade` or `tunnel login` unless the user asks.

## Configuration

Settings come from environment variables, loaded on the server from `/etc/tunnel-relay.env` (root, mode 600) through `EnvironmentFile=-/etc/tunnel-relay.env` in the systemd unit. None of them ever go in the repo.

| Variable | Turns on |
|---|---|
| `TUNNEL_PUBLIC_URL` | Accounts. Required for any sign-in method. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in |
| `RESEND_API_KEY`, `TUNNEL_EMAIL_FROM` | Email sign-in |
| `LEMONSQUEEZY_API_KEY`, `_STORE_ID`, `_WEBHOOK_SECRET`, `_VARIANT_PLUS`, `_VARIANT_PRO` | Billing |
| `TUNNEL_ADMIN_EMAILS` | Admin routes |
| `TUNNEL_STATS_SALT` | Visitor hashing. Without it, unique visitors aren't counted; everything else still is. |

With none of these set, the relay behaves exactly as it does today. Self-hosters are unaffected.

## Code layout

`relay/server.ts` (424 lines) becomes the HTTP shell. Each module registers its routes via `on(method, pattern, handler)`.

| File | Job |
|---|---|
| `relay/server.ts` | HTTP server, routing, body and auth helpers, rate limits, sweep |
| `relay/http.ts` | `HttpError`, `send`, `body`, cookie, origin and redirect helpers (moved out of `server.ts`) |
| `relay/tunnels.ts` | The existing tunnel, invite, message and file routes, moved as they are, plus plan checks |
| `relay/plans.ts` | `PLANS`, `planOfTunnel`, `planOfAccount`, the limit checks |
| `relay/accounts.ts` | Accounts, sessions, `/v1/account*`, device linking, `/v1/auth/logout`, `/v1/auth/methods` |
| `relay/auth-github.ts` | GitHub OAuth routes |
| `relay/auth-email.ts` | Magic-link routes and the Resend client |
| `relay/billing/index.ts`, `relay/billing/lemonsqueezy.ts` | Provider interface, webhook route, plan recompute |
| `relay/stats.ts` | Counters, active devices, `/v1/hit`, `/internal/install` |
| `relay/admin.ts` | Admin routes and the admin check |
| `relay/db.ts` | Schema plus migrations, prepared statements for the new tables |

**Outbound HTTP.** Every call to GitHub, Resend or Lemon Squeezy goes through one injectable `fetch`, which tests replace with a stub.

## Errors

- **User-facing failures** get a sentence saying what happened and what to do next. That covers expired links, provider outages and limits.
- **Webhooks:** 400 on a bad signature (the provider retries), 200 for duplicates and ignored events, and 500 only on our own bugs. Each one is logged with its event type and account id. Bodies are never logged.
- **A webhook for an unknown `account_id`** is logged and answered with 200, so the provider doesn't retry it forever. The admin can fix it by hand.
- **Startup with half a group of variables set** (for example, only `GITHUB_CLIENT_ID`) logs a warning naming the missing variable, and that feature stays off.

## Testing (`node:test`, in-process relay)

**Plans**
- free per-device cap
- paid per-account cap across two linked devices
- file over the limit → 413
- storage cap
- `expires` follows the owner's plan
- downgrade keeps existing tunnels

**Accounts**
- email flow, with the stubbed Resend capturing the link: verify → cookie → `GET /v1/account`
- expired and reused links
- GitHub flow with stubbed endpoints, including merge by email
- `Origin` check
- `return_to` validation

**Device link:** login → approve → poll 200; expiry → 410; logout unlinks.

**Billing**
- valid signature → plan pro → limits rise
- bad signature → 400
- duplicate → no change
- `cancelled` with `ends_at` in the future stays active; the sweep after `ends_at` → free
- admin override wins

**Stats**
- message, file, join and device counters
- active devices dedupe
- beacon: bot dropped, unique counted once, referrer host
- `/internal/install` counting rules

**Admin:** non-admin → 404; stats shape; plan set and clear.

**Self-host default:** no environment variables → the existing 19 tests pass unchanged and the new routes return 404.

**Manual before launch**
- one real Lemon Squeezy test-mode checkout end to end
- a GitHub and an email sign-in on the live site
- the admin page shows today's numbers

## Owner setup (Claude can't create these accounts)

1. **Resend.**
   1. Sign up and add the domain `tunnel.dilyor.dev`.
   2. Add the DNS records it shows (SPF, DKIM, return-path).
   3. Create an API key.
   4. Sender: `tunnel <login@tunnel.dilyor.dev>`.
2. **GitHub OAuth app.**
   1. Settings → Developer settings → OAuth Apps → New.
   2. Homepage: `https://tunnel.dilyor.dev`.
   3. Callback: `https://tunnel.dilyor.dev/v1/auth/github/callback`.
   4. Copy the client id and secret.
3. **Lemon Squeezy.**
   1. Sign up, create a store, and stay in test mode.
   2. Create products: "tunnel Plus", a $5/month subscription, and "tunnel Pro", a $9/month subscription.
   3. Note both variant ids, the store id and an API key.
   4. Add a webhook to `https://tunnel.dilyor.dev/v1/billing/webhook` with a signing secret and the `subscription_*` events.
   5. Submit the store for activation once the legal pages are live.
   6. If the store isn't approved, switch to Paddle (one adapter file).
4. **Server.** Claude writes `/etc/tunnel-relay.env` from the values the owner pastes into a local file, which never goes into chat or the repo, and restarts the service.

## Risks

- **Lemon Squeezy may not keep serving Uzbekistan.** Stripe is moving it onto Managed Payments, which covers about 35 countries. Mitigation: the provider interface plus a ready Paddle path, and admin-granted plans so nothing blocks launch.
- **Tax.** Payouts are personal income in Uzbekistan. The owner handles local declarations. The merchant of record handles customer-side VAT and sales tax.
- **Disk.** 100 MB files with 30-day history: the server has 108 GB free, and per-account storage caps bound the worst case.
- **Abuse of free accounts.** Signing in grants no extra limits, so there's no incentive to farm accounts.
