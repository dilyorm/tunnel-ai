import { secretToken, sha256 } from '../crypto.js';
import type { Accounts } from './accounts.js';
import type { Features } from './config.js';
import { cookies, redirect, safeReturn, setCookie } from './http.js';
import type { App } from './server.js';

// Sign-in with GitHub (OAuth web flow). The state is stored hashed for 10 minutes and must also
// match a cookie in the same browser, so nobody can finish a sign-in that someone else started.

const STATE_COOKIE = 'tunnel_oauth';
const STATE_S = 10 * 60;

export function githubRoutes(app: App, accounts: Accounts, config: NonNullable<Features['github']>) {
  const publicUrl = app.features.publicUrl!;
  const secure = !publicUrl.startsWith('http://');
  const callbackUrl = `${publicUrl}/v1/auth/github/callback`;
  const s = {
    insert: app.store.prepare('INSERT INTO oauth_states (state, return_to, expires) VALUES (?, ?, ?)'),
    take: app.store.prepare<{ return_to: string }>(
      'DELETE FROM oauth_states WHERE state = ? AND expires > ? RETURNING return_to',
    ),
  };
  const clearState = setCookie(STATE_COOKIE, '', 0, { secure, httpOnly: true });

  app.on('GET', '/v1/auth/github/start', async (_req, res, _params, url) => {
    const state = secretToken();
    s.insert.run(sha256(state), safeReturn(url.searchParams.get('return')), Date.now() + STATE_S * 1000);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: callbackUrl,
      scope: 'read:user user:email',
      state,
    }).toString();
    redirect(res, authorize.href, [setCookie(STATE_COOKIE, state, STATE_S, { secure, httpOnly: true })]);
  });

  app.on('GET', '/v1/auth/github/callback', async (req, res, _params, url) => {
    const fail = (code: string) => redirect(res, `/account?error=${code}`, [clearState]);
    const state = url.searchParams.get('state') ?? '';
    if (!state || cookies(req)[STATE_COOKIE] !== state) return fail('github-state');
    const pending = s.take.get(sha256(state), Date.now());
    if (!pending) return fail('github-state');
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) return fail('github-denied');
    let user: { id: number; login: string; email: string } | undefined;
    try {
      user = await fetchUser(code);
    } catch (error) {
      app.log(`GitHub sign-in failed: ${(error as Error).message}`);
      return fail('github');
    }
    if (!user) return fail('github-email');
    const account = accounts.upsertGithub(user);
    redirect(res, safeReturn(pending.return_to), [clearState, ...accounts.startSession(account.id)]);
  });

  /** The GitHub user behind this code, or undefined when they have no verified primary email. */
  async function fetchUser(code: string) {
    const token = await call<{ access_token?: string; error?: string }>('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callbackUrl,
      }),
    });
    if (!token.access_token) throw new Error(`no access token (${token.error ?? 'no error given'})`);
    const headers = {
      authorization: `Bearer ${token.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'tunnel-relay',
    };
    const profile = await call<{ id: number; login: string }>('https://api.github.com/user', { headers });
    const emails = await call<{ email: string; primary: boolean; verified: boolean }[]>(
      'https://api.github.com/user/emails',
      { headers },
    );
    const primary = emails.find((e) => e.primary && e.verified);
    if (!primary) return undefined;
    return { id: profile.id, login: profile.login, email: primary.email.toLowerCase() };
  }

  async function call<T>(url: string, init: RequestInit): Promise<T> {
    const res = await app.fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
    return (await res.json()) as T;
  }
}
