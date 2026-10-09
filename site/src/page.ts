// Shared by every page: calls to the relay's API, the page-view beacon, the nav's Sign in link,
// and the formatters the account and admin pages both use.

export class ApiError extends Error {
  /** The HTTP status, or 0 when the relay couldn't be reached. */
  status: number;
  /** The relay's whole JSON reply, for the few failures that carry more than a sentence. */
  data?: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** Call the relay on this site's origin. A failure carries the relay's own sentence. */
export async function api<T>(method: string, path: string, data?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: data === undefined ? undefined : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new ApiError(0, "Couldn't reach tunnel. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Something went wrong (${res.status}). Try again in a minute.`, body);
  return body as T;
}

/** The sentence to show for a failure. */
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Count this page view. No cookie: the relay keeps a daily count and the referring site's name. */
export function beacon() {
  try {
    navigator.sendBeacon('/v1/hit', JSON.stringify({ p: location.pathname, r: document.referrer }));
  } catch {
    // counting is best effort
  }
}

/** The nav says "Account" instead of "Sign in" once this browser has signed in. */
export function accountLink() {
  if (!/(?:^|;\s*)tunnel_signed_in=1(?:;|$)/.test(document.cookie)) return;
  for (const link of document.querySelectorAll('[data-account-link]')) link.textContent = 'Account';
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Same rounding as the CLI: 10 MB, 2 GB, 0 B. */
export function formatBytes(n: number): string {
  if (n >= GB) return `${+(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${+(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${+(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export const title = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

/** A date in the reader's own format, e.g. 9 Oct 2026. */
export const formatDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** One plain sentence in the page's #status line. */
export function say(text: string, tone: 'ok' | 'error' = 'ok') {
  const status = byId('status');
  status.textContent = text;
  status.dataset.tone = tone;
  status.hidden = false;
}

/** A button that is disabled while its action runs, and reports a failure in #status. */
export function button(label: string, onClick: () => unknown, quiet = false): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = quiet ? 'btn btn-quiet' : 'btn';
  el.textContent = label;
  el.addEventListener('click', async () => {
    el.disabled = true;
    try {
      await onClick();
    } catch (error) {
      say(messageOf(error), 'error');
    } finally {
      el.disabled = false;
    }
  });
  return el;
}
