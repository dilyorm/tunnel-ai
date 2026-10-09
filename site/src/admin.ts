import './style.css';
import './app.css';
import { lineChart, type Line } from './chart';
import { ApiError, accountLink, api, beacon, button, byId, formatDay, messageOf, say, title } from './page';

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

/** A grant's last day as the date picker shows it. The plan ends with that day in UTC, so name that day, not the reader's local one. */
const lastDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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
  until.setAttribute('aria-label', `Last day of the plan for ${account.email} (optional)`);
  if (account.planUntil) until.value = new Date(account.planUntil).toISOString().slice(0, 10);

  box.append(
    select,
    until,
    button('Save', async () => {
      const grant = await api<Grant>('POST', grantPath(account), {
        plan: select.value,
        // The plan runs to the end of the chosen day (UTC).
        until: until.value ? Date.parse(`${until.value}T23:59:59Z`) : null,
      });
      saved({ ...account, ...grant });
      say(`${account.email} is on ${title(grant.plan)}${grant.planUntil ? ` until ${lastDay(grant.planUntil)}` : ''}.`);
    }),
  );
  if (account.planSource === 'admin') {
    box.append(
      button(
        'Clear',
        async () => {
          const grant = await api<Grant>('POST', grantPath(account), { plan: null });
          saved({ ...account, ...grant });
          say(`Cleared the grant for ${account.email}. The account is on ${title(grant.plan)}.`);
        },
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

let query = '';
let next: string | null = null;

async function loadAccounts(fromStart: boolean) {
  const search = new URLSearchParams({ q: query });
  if (!fromStart && next) search.set('cursor', next);
  const page = await api<{ accounts: AdminAccount[]; next: string | null }>('GET', `/v1/admin/accounts?${search}`);
  const body = byId<HTMLTableElement>('accounts').tBodies[0];
  const rows = page.accounts.map(accountRow);
  if (fromStart && rows.length === 0) {
    const row = document.createElement('tr');
    const empty = cell(query ? `No accounts match "${query}".` : 'No accounts yet.');
    empty.colSpan = 6;
    row.append(empty);
    rows.push(row);
  }
  if (fromStart) body.replaceChildren(...rows);
  else body.append(...rows);
  next = page.next;
  byId('more').hidden = !next;
}

byId<HTMLFormElement>('search').addEventListener('submit', (event) => {
  event.preventDefault();
  query = byId<HTMLInputElement>('q').value.trim();
  loadAccounts(true).catch((error) => say(messageOf(error), 'error'));
});

byId('more').addEventListener('click', () => {
  loadAccounts(false).catch((error) => say(messageOf(error), 'error'));
});

// ---------- start ----------

async function main() {
  accountLink();
  beacon();
  let stats: Stats;
  try {
    stats = await api<Stats>('GET', '/v1/admin/stats?days=30');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) byId('denied').hidden = false;
    else say(messageOf(error), 'error');
    return;
  }
  byId('admin').hidden = false;
  showStats(stats);
  await loadAccounts(true).catch((error) => say(messageOf(error), 'error'));
}

main();
