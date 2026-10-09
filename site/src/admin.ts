import './style.css';
import './app.css';
import { lineChart, type Line } from './chart';
import { ApiError, accountLink, api, button, byId, formatDay, messageOf, say, title } from './page';

// The relay owner's page: today's numbers, who is active, plans and revenue, 30-day charts,
// referrers, and the accounts table with plan grants. The API answers 404 to everyone else.

type Plan = 'free' | 'plus' | 'pro';
type Windows = { d1: number; d7: number; d30: number };

interface Stats {
  days: string[];
  series: Record<string, number[]>;
  today: Record<string, number>;
  active: { agents: Windows; devices: Windows; accounts: Windows };
  plans: Record<Plan, number>;
  mrr: number;
  referrers: { host: string; n: number }[];
}

interface AdminAccount {
  id: string;
  email: string;
  githubLogin: string | null;
  plan: Plan;
  planSource: 'billing' | 'admin' | null;
  planUntil: number | null;
  created: number;
  seen: number;
  devices: number;
  tunnels: number;
}

type Grant = Pick<AdminAccount, 'plan' | 'planSource' | 'planUntil'>;

const INK = 'var(--ink)';
const SIGNAL = 'var(--signal)';
const STONE = 'var(--stone)';

function cell(content: string | Node) {
  const td = document.createElement('td');
  td.append(content);
  return td;
}

function numbers(target: HTMLElement, items: [label: string, value: number | string][]) {
  target.replaceChildren(
    ...items.map(([label, value]) => {
      const item = document.createElement('div');
      if (typeof value === 'string') item.className = 'wide';
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = typeof value === 'number' ? value.toLocaleString() : value;
      item.append(dt, dd);
      return item;
    }),
  );
}

function showStats(stats: Stats) {
  const t = stats.today;
  numbers(byId('today'), [
    ['Messages', t.messages],
    ['Tunnels opened', t.tunnels_opened],
    ['Installs', t.installs_sh + t.installs_ps1 + t.installs_npm],
    ['Page views', t.page_views],
    ['Visitors', t.unique_visitors],
    ['Sign-ups', t.signups],
    ['Active agents', stats.active.agents.d1],
  ]);

  const active: [string, Windows][] = [
    ['Agents', stats.active.agents],
    ['Machines', stats.active.devices],
    ['Accounts', stats.active.accounts],
  ];
  byId<HTMLTableElement>('active').tBodies[0].replaceChildren(
    ...active.map(([label, w]) => {
      const row = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = label;
      row.append(th, cell(w.d1.toLocaleString()), cell(w.d7.toLocaleString()), cell(w.d30.toLocaleString()));
      return row;
    }),
  );

  numbers(byId('plans'), [
    ['Free', stats.plans.free],
    ['Plus', stats.plans.plus],
    ['Pro', stats.plans.pro],
    ['Revenue', `$${stats.mrr.toLocaleString()} a month`],
  ]);

  const s = stats.series;
  const charts: [string, Line[]][] = [
    ['Messages', [{ label: 'Messages', values: s.messages, color: INK }]],
    [
      'Installs',
      [
        { label: 'install.sh', values: s.installs_sh, color: INK },
        { label: 'install.ps1', values: s.installs_ps1, color: SIGNAL },
        { label: 'npm', values: s.installs_npm, color: STONE },
      ],
    ],
    [
      'Active',
      [
        { label: 'Agents', values: s.active_members, color: INK },
        { label: 'Machines', values: s.active_devices, color: SIGNAL },
      ],
    ],
    [
      'Landing page',
      [
        { label: 'Views', values: s.page_views, color: INK },
        { label: 'Visitors', values: s.unique_visitors, color: SIGNAL },
      ],
    ],
    ['Sign-ups', [{ label: 'Sign-ups', values: s.signups, color: INK }]],
  ];
  byId('charts').replaceChildren(...charts.map(([name, lines]) => lineChart(name, stats.days, lines)));

  const referrers = byId<HTMLTableElement>('referrers');
  referrers.tBodies[0].replaceChildren(
    ...stats.referrers.map((r) => {
      const row = document.createElement('tr');
      row.append(cell(r.host), cell(r.n.toLocaleString()));
      return row;
    }),
  );
  referrers.hidden = stats.referrers.length === 0;
  byId('no-referrers').hidden = stats.referrers.length > 0;
}

// ---------- accounts ----------

function grantPath(account: AdminAccount) {
  return `/v1/admin/accounts/${encodeURIComponent(account.id)}/plan`;
}

function planControl(account: AdminAccount, saved: (account: AdminAccount) => void) {
  const box = document.createElement('div');
  box.className = 'grant';

  const select = document.createElement('select');
  select.setAttribute('aria-label', `Plan for ${account.email}`);
  for (const plan of ['free', 'plus', 'pro'] as const) {
    select.append(new Option(title(plan), plan, false, plan === account.plan));
  }
  const until = document.createElement('input');
  until.type = 'date';
  until.min = new Date().toISOString().slice(0, 10);
  until.setAttribute('aria-label', `Last day of the plan for ${account.email} (optional)`);
  if (account.planUntil) until.value = new Date(account.planUntil).toISOString().slice(0, 10);

  /** Save and Clear both rebuild the row, so only one runs at a time: every control in it waits. */
  const alone = (action: () => Promise<void>) => async () => {
    const controls = [...box.querySelectorAll<HTMLSelectElement | HTMLInputElement | HTMLButtonElement>('select, input, button')];
    for (const control of controls) control.disabled = true;
    try {
      await action();
    } finally {
      for (const control of controls) control.disabled = false;
    }
  };

  box.append(
    select,
    until,
    button(
      'Save',
      alone(async () => {
        // An empty date is the deliberate "no end date". A half-typed or out-of-range one is not, and must not become it.
        // The plan runs to the end of the chosen day (UTC).
        const end = until.value ? Date.parse(`${until.value}T23:59:59Z`) : null;
        if (until.validity.badInput || (end !== null && !Number.isFinite(end))) {
          throw new Error("That last day isn't a full date. Finish the date, or clear it for no end date.");
        }
        const grant = await api<Grant>('POST', grantPath(account), { plan: select.value, until: end });
        saved({ ...account, ...grant });
        say(`${account.email} is on ${title(grant.plan)}${grant.planUntil ? ` until ${formatDay(grant.planUntil)}` : ''}.`);
      }),
    ),
  );
  if (account.planSource === 'admin') {
    box.append(
      button(
        'Clear',
        alone(async () => {
          const grant = await api<Grant>('POST', grantPath(account), { plan: null });
          saved({ ...account, ...grant });
          say(`Cleared the grant for ${account.email}. The account is on ${title(grant.plan)}.`);
        }),
        true,
      ),
    );
  }
  const source = document.createElement('span');
  source.className = 'muted';
  source.textContent = account.planSource === 'admin' ? 'granted' : account.planSource === 'billing' ? 'paid' : '';
  box.append(source);
  return box;
}

function accountRow(account: AdminAccount): HTMLTableRowElement {
  const row = document.createElement('tr');
  const who = cell(account.email);
  if (account.githubLogin) {
    const login = document.createElement('span');
    login.className = 'muted';
    login.textContent = ` @${account.githubLogin}`;
    who.append(login);
  }
  row.append(
    who,
    cell(planControl(account, (updated) => row.replaceWith(accountRow(updated)))),
    cell(account.devices.toLocaleString()),
    cell(account.tunnels.toLocaleString()),
    cell(formatDay(account.created)),
    cell(formatDay(account.seen)),
  );
  return row;
}

/** What the table shows now: the search it answers, and where its next page starts. */
let shown: { query: string; next: string | null } = { query: '', next: null };
/** Numbers the loads, so that only the newest one may change the table. */
let newest = 0;

/** The first page of a search (no cursor), or the page after `cursor` of the search already shown. */
async function loadAccounts(query: string, cursor: string | null) {
  const mine = ++newest;
  const more = byId<HTMLButtonElement>('more');
  more.disabled = true;
  try {
    const search = new URLSearchParams({ q: query });
    if (cursor) search.set('cursor', cursor);
    const page = await api<{ accounts: AdminAccount[]; next: string | null }>('GET', `/v1/admin/accounts?${search}`);
    // A newer search or page was asked for while this one was on its way: its answer wins, this one is dropped.
    if (mine !== newest) return;
    const body = byId<HTMLTableElement>('accounts').tBodies[0];
    const rows = page.accounts.map(accountRow);
    if (!cursor && rows.length === 0) {
      const row = document.createElement('tr');
      const empty = cell(query ? `No accounts match "${query}".` : 'No accounts yet.');
      empty.colSpan = 6;
      row.append(empty);
      rows.push(row);
    }
    if (cursor) body.append(...rows);
    else body.replaceChildren(...rows);
    shown = { query, next: page.next };
    more.hidden = !page.next;
  } catch (error) {
    if (mine === newest) throw error; // a dropped load's failure is not worth reporting
  } finally {
    if (mine === newest) more.disabled = false;
  }
}

byId<HTMLFormElement>('search').addEventListener('submit', (event) => {
  event.preventDefault();
  loadAccounts(byId<HTMLInputElement>('q').value.trim(), null).catch((error) => say(messageOf(error), 'error'));
});

byId('more').addEventListener('click', () => {
  loadAccounts(shown.query, shown.next).catch((error) => say(messageOf(error), 'error'));
});

// ---------- start ----------

async function main() {
  accountLink();
  let stats: Stats;
  try {
    stats = await api<Stats>('GET', '/v1/admin/stats?days=30');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) byId('denied').hidden = false;
    else say(messageOf(error), 'error');
    return;
  }
  showStats(stats);
  byId('admin').hidden = false;
  await loadAccounts('', null);
}

main().catch((error) => say(messageOf(error), 'error'));
