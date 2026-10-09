// Shared by every page: calls to the relay's API, the page-view beacon, the nav's Sign in link,
// and the formatters the account and admin pages both use.

export class ApiError extends Error {
  /** The HTTP status, or 0 when the relay couldn't be reached. */
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Something went wrong (${res.status}). Try again in a minute.`);
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
