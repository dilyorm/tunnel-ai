import './style.css';
import { mountWormhole, type Message } from './wormhole';

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
