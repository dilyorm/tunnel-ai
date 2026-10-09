import { secretToken, sha256 } from '../crypto.js';
import type { Accounts } from './accounts.js';
import type { Features } from './config.js';
import { HttpError, LIMITS, json, redirect, safeReturn, send } from './http.js';
import type { App } from './server.js';

// Sign-in by email: the relay mails a one-time link through Resend.

const LINK_MS = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function normalizeEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return email;
}

export function emailRoutes(app: App, accounts: Accounts, config: NonNullable<Features['email']>) {
  const publicUrl = app.features.publicUrl!;
  const s = {
    insert: app.store.prepare('INSERT INTO email_logins (token_hash, email, return_to, expires) VALUES (?, ?, ?, ?)'),
    drop: app.store.prepare('DELETE FROM email_logins WHERE token_hash = ?'),
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

  app.on('POST', '/v1/auth/email', async (req, res) => {
    accounts.requireOrigin(req);
    const input = await json<{ email?: unknown; return?: unknown }>(req);
    const email = normalizeEmail(input.email);
    perClient(req);
    perAddress(req, email);
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
    // The same answer whether or not an account exists for this address.
    send(res, 202, { ok: true });
  });

  // Mail scanners open links to check them. This GET only hands the token to the account page,
  // which spends it with the POST below, so a scanner can't use the link up.
  app.on('GET', '/v1/auth/email/verify', async (_req, res, _params, url) => {
    redirect(res, `/account?login=${encodeURIComponent(url.searchParams.get('token') ?? '')}`);
  });

  app.on('POST', '/v1/auth/email/verify', async (req, res) => {
    accounts.requireOrigin(req);
    const input = await json<{ token?: unknown }>(req);
    const login =
      typeof input.token === 'string' && input.token ? s.take.get(sha256(input.token), Date.now()) : undefined;
    if (!login) throw new HttpError(410, 'This sign-in link expired or was already used. Ask for a new one.');
    const account = accounts.upsertByEmail(login.email);
    send(res, 200, { returnTo: login.return_to }, { 'set-cookie': accounts.startSession(account.id) });
  });
}
