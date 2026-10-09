import './style.css';
import { mountWormhole, type Message } from './wormhole';
import { accountLink, api, beacon } from './page';

// The Plus and Pro buttons say "Coming soon" in the markup. They become links only when the relay
// answers that it sells plans; any other answer, or none, leaves them as they are.
const PLAN_LABELS: Record<string, string> = { plus: 'Get Plus', pro: 'Get Pro' };

async function openPricing() {
  try {
    const methods = await api<{ billing?: unknown }>('GET', '/v1/auth/methods');
    if (methods?.billing !== true) return;
    for (const [plan, label] of Object.entries(PLAN_LABELS)) {
      const button = document.querySelector<HTMLAnchorElement>(`.btn[data-plan="${plan}"]`);
      if (!button) continue;
      button.href = `/account?plan=${plan}`;
      button.textContent = label;
      button.removeAttribute('aria-disabled');
      button.removeAttribute('role');
    }
  } catch {
    // The relay didn't answer: the buttons stay "Coming soon".
  }
}

// Count the view, fix the nav and ask about billing first: nothing below (icons, canvas) may stop them by throwing.
accountLink();
beacon();
void openPricing();

// ---------- pixel icons (8×8 bitmaps) ----------

const ICONS: Record<string, string[]> = {
  lock: [
    '..####..',
    '.#....#.',
    '.#....#.',
    '########',
    '###..###',
    '####.###',
    '########',
    '........',
  ],
  mailbox: [
    '........',
    '########',
    '##....##',
    '#.#..#.#',
    '#..##..#',
    '#......#',
    '########',
    '........',
  ],
  file: [
    '#####...',
    '#...##..',
    '#...#.#.',
    '#...####',
    '#......#',
    '#.####.#',
    '#......#',
    '########',
  ],
  agents: [
    '##....##',
    '##....##',
    '..#..#..',
    '...##...',
    '...##...',
    '..#..#..',
    '##....##',
    '##....##',
  ],
  bolt: [
    '....###.',
    '...###..',
    '..###...',
    '.######.',
    '...###..',
    '..###...',
    '.##.....',
    '.#......',
  ],
  server: [
    '########',
    '#......#',
    '#.##..##',
    '########',
    '########',
    '#......#',
    '#.##..##',
    '########',
  ],
};

function pixelIcon(rows: string[]): string {
  let d = '';
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === '#') d += `M${x} ${y}h1v1H${x}z`;
    });
  });
  return `<svg viewBox="0 0 8 8" aria-hidden="true" shape-rendering="crispEdges"><path d="${d}"/></svg>`;
}

document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
  const rows = ICONS[el.dataset.icon!];
  if (rows) el.innerHTML = pixelIcon(rows);
});

// ---------- install tabs ----------

// Each command is [program, host, rest]; it may wrap only between the three.
const INSTALLS: Record<string, { prompt: string; parts: [string, string, string]; note: string }> = {
  unix: {
    prompt: '$',
    parts: ['curl -fsSL', 'https://tunnel.dilyor.dev/', 'install.sh | sh'],
    note: 'Installs to ~/.tunnel. Brings its own Node if yours is older than 22.13.',
  },
  windows: {
    prompt: '>',
    parts: ['irm', 'https://tunnel.dilyor.dev/', 'install.ps1 | iex'],
    note: 'Run in PowerShell. Installs to ~\\.tunnel and brings its own Node if yours is older than 22.13.',
  },
  npm: {
    prompt: '$',
    parts: ['npm i -g', 'https://tunnel.dilyor.dev/', 'tunnel-ai.tgz'],
    note: 'Needs Node 22.13 or newer. Hosted here until the npm release.',
  },
};

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-install]')];
const panel = document.getElementById('install');

function pickInstall(tab: HTMLButtonElement, focus = false) {
  const install = INSTALLS[tab.dataset.install!];
  if (!install || !panel) return;
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  if (focus) tab.focus();
  panel.setAttribute('aria-labelledby', tab.id);
  const [program, host, rest] = install.parts;
  const cmd = panel.querySelector('.cmd')!;
  cmd.replaceChildren(span(program), ' ', span(host), document.createElement('wbr'), span(rest));
  panel.querySelector('.prompt')!.textContent = install.prompt;
  panel.querySelector<HTMLButtonElement>('[data-copy]')!.dataset.copy = `${program} ${host}${rest}`;
  const note = document.querySelector('.hero-note');
  if (note) note.textContent = install.note;
}

function span(text: string) {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => pickInstall(tab));
  tab.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    pickInstall(tabs[(i + step + tabs.length) % tabs.length], true);
  });
});

if (/Windows/i.test(navigator.userAgent)) {
  const windows = tabs.find((t) => t.dataset.install === 'windows');
  if (windows) pickInstall(windows);
}

// ---------- copy buttons ----------

document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
  let timer = 0;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy!);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Press Ctrl+C';
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => (btn.textContent = 'Copy'), 1600);
  });
});

// ---------- wormhole ----------

const SCRIPT: Message[] = [
  { from: 0, text: 'Schema is ready. Sending api.json.', file: 'api.json' },
  { from: 1, text: 'Got it. Generating client types now.' },
  { from: 1, text: 'Migrations ran on staging. 42 tests pass.' },
  { from: 0, text: 'Deploying the frontend. Tell me if logs go red.' },
  { from: 1, text: 'Logs are clean. Ending my turn.' },
];

const NAMES = ['claude@laptop', 'codex@server'];

const canvas = document.querySelector<HTMLCanvasElement>('#wormhole');
const caption = document.querySelector<HTMLElement>('.band-caption');
const dirEl = document.querySelector<HTMLElement>('#band-dir');
const textEl = document.querySelector<HTMLElement>('#band-text');
const lanes = document.querySelectorAll<HTMLElement>('.lane-name');

function setActive(side: number | null) {
  lanes.forEach((l) => l.classList.toggle('is-active', Number(l.dataset.lane) === side));
}

if (canvas && caption && dirEl && textEl) {
  mountWormhole(canvas, SCRIPT, {
    onLayout(edgePx, laptopPx) {
      caption.style.setProperty('--edge', `${edgePx}px`);
      caption.style.setProperty('--laptop', `${laptopPx}px`);
    },
    onSend(msg) {
      dirEl.textContent = msg.from === 0 ? `${NAMES[0]} to ${NAMES[1]}` : `${NAMES[1]} to ${NAMES[0]}`;
      textEl.textContent = msg.file ? `“${msg.text}” + ${msg.file}` : `“${msg.text}”`;
      caption.classList.remove('is-delivered');
      setActive(msg.from);
    },
    onDeliver(msg) {
      caption.classList.add('is-delivered');
      setActive(msg.from === 0 ? 1 : 0);
    },
  });
}
