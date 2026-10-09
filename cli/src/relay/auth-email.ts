import { secretToken, sha256 } from '../crypto.js';
import type { Accounts } from './accounts.js';
import type { Features } from './config.js';
import { HttpError, LIMITS, cookies, json, redirect, safeReturn, send, setCookie } from './http.js';
import type { App } from './server.js';

// Sign-in by email: the relay mails a one-time link through Resend.

const LINK_MS = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/**
 * Ties a link to the browser that asked for it. Opening a link in a browser that didn't ask for it
 * needs a confirmation, so an attacker can't sign a victim into the attacker's account by getting the
 * victim to open a link the attacker requested (login CSRF).
 */
export const LOGIN_COOKIE = 'tunnel_login';

export function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return email;
}

/**
 * The address as the per-address send limit counts it, so a plus tag, Gmail dots or googlemail.com
 * don't buy extra emails to one mailbox. The account keeps the address as typed; only the limiter
 * sees this form. Takes a normalized (trimmed, lowercase) address.
 */
export function limiterKey(email: string): string {
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  local = local.split('+')[0] || local;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '') || local;
  return `${local}@${domain}`;
}

/** "ada@example.com" -> "a…@example.com": enough for the person to recognise their own address. */
function mask(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}…${email.slice(at)}`;
}

export function emailRoutes(app: App, accounts: Accounts, config: NonNullable<Features['email']>) {
  const publicUrl = app.features.publicUrl!;
  // Same rule as the session cookie.
  const secure = !publicUrl.startsWith('http://');
  const s = {
    insert: app.store.prepare('INSERT INTO email_logins (token_hash, email, return_to, expires) VALUES (?, ?, ?, ?)'),
    drop: app.store.prepare('DELETE FROM email_logins WHERE token_hash = ?'),
    pending: app.store.prepare<{ email: string }>('SELECT email FROM email_logins WHERE token_hash = ? AND expires > ?'),
    // Spending a link deletes it, so it works once.
    take: app.store.prepare<{ email: string; return_to: string }>(
      'DELETE FROM email_logins WHERE token_hash = ? AND expires > ? RETURNING email, return_to',
    ),
  };
  const perClient = app.counter(
    HOUR,
    LIMITS.loginEmailsPerClient,
    'Too many sign-in emails from this network. Try again in an hour.',
  );
  const perAddress = app.counter(
    HOUR,
    LIMITS.loginEmailsPerAddress,
    'Too many sign-in emails for this address. Use the newest one, or try again in an hour.',
  );
  // A cap on the whole relay, so many clients and many addresses together can't turn the relay
  // into a mail cannon (or run up the Resend bill).
  const perRelay = app.counter(
    HOUR,
    LIMITS.loginEmailsPerHour,
    'Too many sign-in emails are being sent right now. Try again in an hour.',
  );

  app.on('POST', '/v1/auth/email', async (req, res) => {
    accounts.requireOrigin(req);
    const input = await json<{ email?: unknown; return?: unknown }>(req);
    const email = normalizeEmail(input.email);
    perClient(req);
    perAddress(req, limiterKey(email));
    perRelay(req, 'relay');
    const token = secretToken();
    const hash = sha256(token);
    s.insert.run(hash, email, safeReturn(input.return), Date.now() + LINK_MS);
    const link = `${publicUrl}/v1/auth/email/verify?token=${token}`;
    try {
      const reply = await app.fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: config.from,
          to: [email],
          subject: 'Your tunnel sign-in link',
          text:
            `Open this link to sign in to tunnel:\n\n${link}\n\n` +
            "It works once, for 15 minutes. If you didn't ask for it, ignore this email.\n",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!reply.ok) throw new Error(`Resend answered ${reply.status}`);
    } catch (error) {
      s.drop.run(hash);
      app.log(`Sign-in email failed: ${(error as Error).message}`);
      throw new HttpError(502, "Couldn't send the email. Try again or sign in with GitHub.");
    }
    // The same answer whether or not an account exists for this address. The cookie holds a hash of
    // the token, not the token, so it can't be used to sign in by itself.
    send(
      res,
      202,
      { ok: true },
      { 'set-cookie': [setCookie(LOGIN_COOKIE, sha256(`bind:${token}`), LINK_MS / 1000, { secure, httpOnly: true })] },
    );
  });

  // Mail scanners open links to check them. This GET only hands the token to the account page,
  // which spends it with the POST below, so a scanner can't use the link up.
  app.on('GET', '/v1/auth/email/verify', async (_req, res, _params, url) => {
    redirect(res, `/account?login=${encodeURIComponent(url.searchParams.get('token') ?? '')}`);
  });

  app.on('POST', '/v1/auth/email/verify', async (req, res) => {
    accounts.requireOrigin(req);
    const input = await json<{ token?: unknown; confirm?: unknown }>(req);
    const token = typeof input.token === 'string' ? input.token : '';
    const expired = () => new HttpError(410, 'This sign-in link expired or was already used. Ask for a new one.');
    if (!token) throw expired();
    const hash = sha256(token);
    // The browser that asked for the link may spend it. Any other browser has to say it means to.
    const askedHere = cookies(req)[LOGIN_COOKIE] === sha256(`bind:${token}`);
    if (!askedHere && input.confirm !== true) {
      const pending = s.pending.get(hash, Date.now());
      if (!pending) throw expired();
      send(res, 409, { error: 'Confirm this sign-in.', confirm: mask(pending.email) });
      return;
    }
    const login = s.take.get(hash, Date.now());
    if (!login) throw expired();
    const account = accounts.upsertByEmail(login.email);
    send(
      res,
      200,
      { returnTo: login.return_to },
      { 'set-cookie': [...accounts.startSession(account.id), setCookie(LOGIN_COOKIE, '', 0, { secure, httpOnly: true })] },
    );
  });
}
