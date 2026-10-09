import './style.css';
import './app.css';
import { ApiError, api, beacon, button, byId, formatBytes, formatDay, messageOf, say, title } from './page';

// The account page. Signed out: the sign-in methods this relay has. Signed in: plan, usage,
// linked machines and billing. It also finishes flows that start elsewhere, via the address bar:
//   ?login=TOKEN    an emailed sign-in link, spent here with a POST so mail scanners can't use it up
//   ?link=CODE      a machine running `tunnel login`, waiting for this account to confirm
//   ?plan=plus|pro  the pricing buttons: go to checkout as soon as the person is signed in
//   ?upgraded=1     back from checkout
//   ?error=CODE     a GitHub sign-in that failed

type Plan = 'free' | 'plus' | 'pro';

interface Me {
  email: string;
  githubLogin: string | null;
  plan: Plan;
  planSource: 'billing' | 'admin' | null;
  planUntil: number | null;
  limits: { tunnels: number; perDevice: boolean; fileBytes: number; historyDays: number; storageBytes: number };
  usage: { tunnels: number; storageBytes: number };
  devices: { id: string; created: number; seen: number | null; tunnels: number }[];
  subscription: { plan: Plan; status: string; renewsAt: number | null; endsAt: number | null } | null;
  admin: boolean;
}

interface Methods {
  github: boolean;
  email: boolean;
  billing: boolean;
}

const PRICES = { plus: 5, pro: 9 } as const;
const RANK: Record<Plan, number> = { free: 0, plus: 1, pro: 2 };

const NO_PAID_PLANS = "Paid plans aren't open yet.";

const ERRORS: Record<string, string> = {
  'github-state': 'That sign-in took too long or started in another browser. Try again.',
  'github-denied': 'GitHub sign-in was cancelled.',
  github: "GitHub didn't answer. Try again in a minute.",
  'github-email': 'Your GitHub account has no verified primary email. Add one on GitHub, or sign in with email.',
  'github-taken': 'That email already belongs to an account linked to a different GitHub user. Sign in with email instead.',
};

const params = new URLSearchParams(location.search);

/** Take handled flags out of the address bar, so a reload doesn't repeat them. */
function forget(...names: string[]) {
  const url = new URL(location.href);
  for (const name of names) url.searchParams.delete(name);
  history.replaceState(null, '', url.pathname + url.search);
}

function wantedPlan(): 'plus' | 'pro' | undefined {
  const plan = params.get('plan');
  return plan === 'plus' || plan === 'pro' ? plan : undefined;
}

/** Sign-in comes back here, with any ?plan or ?link still waiting. */
const here = () => location.pathname + location.search;

async function load(): Promise<Me | undefined> {
  try {
    return await api<Me>('GET', '/v1/account');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return undefined;
    throw error;
  }
}

async function checkout(plan: 'plus' | 'pro') {
  const { url } = await api<{ url: string }>('POST', '/v1/account/checkout', { plan });
  location.assign(url);
}

// ---------- signed out ----------

function showSignedOut(methods: Methods) {
  byId('signed-out').hidden = false;
  const github = byId<HTMLAnchorElement>('github');
  github.href = `/v1/auth/github/start?return=${encodeURIComponent(here())}`;
  github.hidden = !methods.github;
  const form = byId<HTMLFormElement>('email-form');
  form.hidden = !methods.email;

  const plan = wantedPlan();
  if (!methods.github && !methods.email) say("Sign-in isn't set up on this relay yet.");
  else if (params.has('link')) say('Sign in to link your machine.');
  else if (plan) say(methods.billing ? `Sign in to get ${title(plan)}.` : NO_PAID_PLANS);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button')!;
    submit.disabled = true;
    try {
      await api('POST', '/v1/auth/email', { email: byId<HTMLInputElement>('email').value, return: here() });
      form.hidden = true;
      github.hidden = true;
      byId('email-sent').hidden = false;
    } catch (error) {
      say(messageOf(error), 'error');
    } finally {
      submit.disabled = false;
    }
  });
}

// ---------- signed in ----------

function planLine(me: Me): string {
  const name = title(me.plan);
  if (me.planSource === 'admin') return me.planUntil ? `${name} until ${formatDay(me.planUntil)}` : name;
  const sub = me.subscription;
  if (sub?.endsAt) return `${name}, ends ${formatDay(sub.endsAt)}`;
  if (sub?.renewsAt) return `${name}, renews ${formatDay(sub.renewsAt)}`;
  return name;
}

function tunnelsLine({ limits, usage }: Me): string {
  if (limits.tunnels === 0) return `${usage.tunnels} open`;
  if (limits.perDevice) return `${usage.tunnels} open, ${limits.tunnels} per machine`;
  return `${usage.tunnels} of ${limits.tunnels}`;
}

function filesLine({ limits, usage }: Me): string {
  const each = `Up to ${formatBytes(limits.fileBytes)} each`;
  if (!limits.storageBytes) return each;
  return `${each}, ${formatBytes(usage.storageBytes)} of ${formatBytes(limits.storageBytes)} stored`;
}

function planActions(me: Me, methods: Methods) {
  const actions = byId('plan-actions');
  actions.replaceChildren();
  if (me.subscription) {
    // Plan changes and cancelling happen in Lemon Squeezy's portal; its links expire, so fetch one now.
    actions.append(
      button('Manage billing', async () => {
        const { url } = await api<{ url: string }>('GET', '/v1/account/portal');
        location.assign(url);
      }),
    );
    return;
  }
  if (!methods.billing) return;
  for (const plan of ['plus', 'pro'] as const) {
    if (RANK[plan] > RANK[me.plan]) {
      actions.append(button(`Get ${title(plan)}, $${PRICES[plan]} a month`, () => checkout(plan)));
    }
  }
}

function showMachines(me: Me, refresh: () => Promise<void>) {
  const table = byId<HTMLTableElement>('machines');
  const rows = me.devices.map((device) => {
    const row = document.createElement('tr');
    const id = document.createElement('code');
    id.textContent = device.id;
    const cells = [id, String(device.tunnels), device.seen ? formatDay(device.seen) : 'Not yet'];
    for (const content of cells) {
      const td = document.createElement('td');
      td.append(content);
      row.append(td);
    }
    const actions = document.createElement('td');
    actions.append(
      button(
        'Unlink',
        async () => {
          await api('POST', `/v1/account/devices/${encodeURIComponent(device.id)}/unlink`);
          say(`Unlinked ${device.id}. Its tunnels stay open on the Free plan's limits.`);
          await refresh();
        },
        true,
      ),
    );
    row.append(actions);
    return row;
  });
  table.tBodies[0].replaceChildren(...rows);
  table.hidden = rows.length === 0;
  byId('no-machines').hidden = rows.length > 0;
}

function showSignedIn(me: Me, methods: Methods, refresh: () => Promise<void>) {
  byId('signed-in').hidden = false;
  byId('me-email').textContent = me.githubLogin ? `${me.email} (GitHub: ${me.githubLogin})` : me.email;
  byId('me-plan').textContent = planLine(me);
  byId('me-tunnels').textContent = tunnelsLine(me);
  byId('me-files').textContent = filesLine(me);
  byId('me-history').textContent = `${me.limits.historyDays} days`;
  planActions(me, methods);
  showMachines(me, refresh);
  byId('admin-link').hidden = !me.admin;
}

function showLinkCard(code: string, refresh: () => Promise<void>) {
  const card = byId('link-card');
  byId('link-code').textContent = code;
  card.hidden = false;
  const close = () => {
    card.hidden = true;
    forget('link');
  };
  byId('link-cancel').addEventListener('click', close, { once: true });
  const confirm = byId<HTMLButtonElement>('link-confirm');
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      await api('POST', '/v1/account/devices/link', { userCode: code });
      close();
      say('Machine linked. Its terminal will say so in a few seconds.');
      await refresh();
    } catch (error) {
      close();
      say(messageOf(error), 'error');
    } finally {
      confirm.disabled = false;
    }
  });
}

// ---------- emailed sign-in links ----------

/** The masked address the relay wants confirmed ("a…@example.com"), if this failure is that question. */
function addressToConfirm(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const address = (error.data as { confirm?: unknown } | undefined)?.confirm;
  return typeof address === 'string' && address ? address : undefined;
}

/**
 * A link opened in a browser that didn't ask for it is only spent once the person says so, so a link
 * someone else requested can't sign them into that someone's account. Nothing is sent until the click.
 */
function askToConfirm(token: string, address: string) {
  const row = byId('login-confirm');
  say(`Sign in as ${address}?`);
  const signIn = button('Sign in', async () => {
    try {
      const { returnTo } = await api<{ returnTo: string }>('POST', '/v1/auth/email/verify', { token, confirm: true });
      location.replace(returnTo);
    } catch (error) {
      // Same as a link that failed at once: say why, and carry on as if the page had been opened plain.
      row.hidden = true;
      await show();
      say(messageOf(error), 'error');
    }
  });
  row.replaceChildren(signIn);
  row.hidden = false;
  signIn.focus();
}

/** Spend an emailed link. true: this page is on its way elsewhere, or waiting for the person to confirm. */
async function spendLink(token: string): Promise<boolean> {
  try {
    const { returnTo } = await api<{ returnTo: string }>('POST', '/v1/auth/email/verify', { token });
    location.replace(returnTo);
    return true;
  } catch (error) {
    const address = addressToConfirm(error);
    if (address === undefined) {
      say(messageOf(error), 'error');
      return false;
    }
    askToConfirm(token, address);
    return true;
  }
}

// ---------- start ----------

byId('sign-out').addEventListener('click', async () => {
  try {
    await api('POST', '/v1/auth/logout');
    location.assign('/');
  } catch (error) {
    say(messageOf(error), 'error');
  }
});

/** Everything the page shows once any emailed link has been dealt with. */
async function show() {
  const failed = params.get('error');
  if (failed) {
    forget('error');
    say(ERRORS[failed] ?? 'Sign-in failed. Try again.', 'error');
  }
  const upgraded = params.has('upgraded');
  if (upgraded) {
    forget('upgraded');
    say('Payment received. Your new plan shows here as soon as Lemon Squeezy confirms it, usually within a minute.');
  }

  let methods: Methods;
  let me: Me | undefined;
  try {
    methods = await api<Methods>('GET', '/v1/auth/methods');
    me = await load();
  } catch (error) {
    say(error instanceof ApiError && error.status === 404 ? "This relay doesn't have accounts." : messageOf(error), 'error');
    return;
  }
  if (!me) return showSignedOut(methods);

  const plan = wantedPlan();
  if (plan) {
    forget('plan');
    if (!methods.billing) say(NO_PAID_PLANS);
    else if (RANK[plan] <= RANK[me.plan]) say(`You're already on ${title(me.plan)}.`);
    else {
      try {
        return await checkout(plan);
      } catch (error) {
        say(messageOf(error), 'error');
      }
    }
  }

  const refresh = async () => {
    const fresh = await load();
    if (fresh) showSignedIn(fresh, methods, refresh);
    else location.reload();
  };
  showSignedIn(me, methods, refresh);
  const link = params.get('link');
  if (link) showLinkCard(link, refresh);

  // The webhook can land a few seconds after the redirect back from checkout.
  if (upgraded && me.plan === 'free') {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const fresh = await load().catch(() => undefined);
      if (fresh && fresh.plan !== 'free') {
        showSignedIn(fresh, methods, refresh);
        say(`You're on ${title(fresh.plan)} now.`);
        break;
      }
    }
  }
}

async function main() {
  beacon();

  const login = params.get('login');
  if (login) {
    // Out of the address bar before anything is sent, so the token can't linger in the URL or history.
    forget('login');
    if (await spendLink(login)) return;
  }
  await show();
}

main();
