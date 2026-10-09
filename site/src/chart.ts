// A small line chart in inline SVG: one or more series over the same days, gridlines at zero, half
// and the top, the first and last day, and a legend with today's value. No chart library.

export interface Line {
  label: string;
  values: number[];
  /** Any CSS color, e.g. 'var(--signal)'. */
  color: string;
}

const W = 400;
const H = 150;
const PAD = { top: 10, right: 6, bottom: 24, left: 36 };
const NS = 'http://www.w3.org/2000/svg';

/** The top of the axis: 4, or 1, 2, 4, 6, 8 or 10 times a power of ten, so the halfway line is a whole number. */
export function niceMax(n: number): number {
  if (n <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * power >= n) return m * power;
  return 10 * power;
}

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>, text?: string) {
  const el = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** '2026-10-09' → '9 Oct', in the reader's own format. */
const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function lineChart(name: string, days: string[], lines: Line[]): HTMLElement {
  const max = niceMax(Math.max(0, ...lines.flatMap((line) => line.values)));
  const last = days.length - 1;
  const x = (i: number) => PAD.left + (last === 0 ? 0 : (i / last) * (W - PAD.left - PAD.right));
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);

  const summary = lines
    .map((line) => `${line.label}: ${line.values.at(-1) ?? 0} today, ${line.values.reduce((a, b) => a + b, 0)} in ${days.length} days`)
    .join('; ');
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${name}. ${summary}.` });

  for (const v of [0, max / 2, max]) {
    chart.append(
      svg('line', { x1: PAD.left, x2: W - PAD.right, y1: y(v), y2: y(v), class: v === 0 ? 'chart-axis' : 'chart-grid' }),
      svg('text', { x: PAD.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-label' }, v.toLocaleString()),
    );
  }
  for (const line of lines) {
    const points = line.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const polyline = svg('polyline', { points, class: 'chart-line' });
    polyline.style.stroke = line.color;
    chart.append(polyline);
  }
  chart.append(
    svg('text', { x: x(0), y: H - 6, class: 'chart-label' }, shortDay(days[0])),
    svg('text', { x: x(last), y: H - 6, 'text-anchor': 'end', class: 'chart-label' }, shortDay(days[last])),
  );

  const figure = document.createElement('figure');
  figure.className = 'chart';
  const caption = document.createElement('figcaption');
  caption.textContent = name;
  const legend = document.createElement('ul');
  legend.className = 'chart-legend';
  for (const line of lines) {
    const item = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'chart-swatch';
    swatch.style.background = line.color;
    item.append(swatch, `${line.label} ${(line.values.at(-1) ?? 0).toLocaleString()} today`);
    legend.append(item);
  }
  figure.append(caption, chart, legend);
  return figure;
}
