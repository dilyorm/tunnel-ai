// Pixel wormhole: two machines, a dithered tunnel between them, packets flying both ways.
// Rendered at low resolution into an ImageData buffer, scaled up with image-rendering: pixelated.

const HEX = {
  paper: 0xffffff,
  ink: 0x1e1712,
  signal: 0xff5b00,
  ember: 0xffb07a,
  haze: 0xfff1e6,
  stone: 0x8c817a,
  rule: 0xeee8e3,
} as const;

type Color = keyof typeof HEX;

// ImageData is RGBA bytes; a Uint32 view on little-endian reads them as ABGR.
const U32 = Object.fromEntries(
  Object.entries(HEX).map(([k, v]) => {
    const r = (v >> 16) & 255;
    const g = (v >> 8) & 255;
    const b = v & 255;
    return [k, ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0];
  }),
) as Record<Color, number>;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)];

export type Side = 0 | 1; // 0 = left machine, 1 = right machine

export interface Message {
  from: Side;
  text: string;
  file?: string;
}

export interface WormholeEvents {
  onSend?(msg: Message): void;
  onDeliver?(msg: Message): void;
  onLayout?(edgePx: number, laptopPx: number): void;
}

interface Packet {
  dir: 1 | -1;
  x: number;
  phase: number;
  size: number;
  color: Color;
  trail: { x: number; y: number }[];
  msg?: Message;
  last: boolean;
}

interface ScreenLine {
  len: number;
  hot: number;
}

const LAPTOP_W = 26;
const FPS = 24;

export function mountWormhole(
  canvas: HTMLCanvasElement,
  script: Message[],
  events: WormholeEvents = {},
) {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // scene geometry (logical pixels)
  let W = 0;
  let H = 0;
  let px = 4;
  let edge = 0;
  let leftX = 0;
  let rightX = 0;
  let laptopY = 0;
  let cy = 0;
  let cx = 0;
  let span = 0; // half-length of the ring domain
  let rMouth = 0;
  let rThroat = 0;
  let rings = 0;

  let image: ImageData;
  let buf: Uint32Array;

  // simulation state
  let time = 0;
  let packets: Packet[] = [];
  const screens: ScreenLine[][] = [[], []];
  let scriptIndex = 0;
  let nextSendAt = 0.6;
  let queued: { at: number; packet: Packet }[] = [];
  let inFlight = 0;

  // ---------- geometry ----------

  let ready = false;

  // Returns false while the band has no width yet (hidden tab, collapsed pane).
  function layout(): boolean {
    const cssW = canvas.parentElement!.clientWidth;
    if (cssW < 1) return false;
    px = cssW >= 1100 ? 5 : cssW >= 700 ? 4 : 3;
    W = Math.ceil(cssW / px);
    H = cssW >= 700 ? 84 : 72;
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W * px}px`;
    canvas.style.height = `${H * px}px`;
    image = ctx.createImageData(W, H);
    buf = new Uint32Array(image.data.buffer);

    edge = Math.max(3, Math.round(W * (W < 160 ? 0.03 : 0.07)));
    leftX = edge;
    rightX = W - edge - LAPTOP_W;
    cy = Math.round(H / 2);
    laptopY = cy - 9;
    const L = leftX + LAPTOP_W + 3;
    const R = rightX - 3;
    cx = (L + R) / 2;
    rMouth = Math.min(Math.round(H * 0.42), Math.round((R - L) * 0.32));
    rThroat = Math.max(3, Math.round(rMouth * 0.14));
    // keep the widest ellipse clear of the machines
    span = (R - L) / 2 - rMouth * 0.4;
    rings = Math.max(6, Math.round(span / 4.5));
    events.onLayout?.(edge * px, LAPTOP_W * px);
    ready = true;
    return true;
  }

  const radius = (s: number) => rThroat + (rMouth - rThroat) * Math.pow(Math.abs(s), 1.7);
  // horizontal radius: rings face the viewer near the throat, open up near the mouths
  const radiusX = (s: number) => radius(s) * 0.4 * Math.abs(s);
  const depthAt = (x: number) => 1 - Math.min(1, Math.abs(x - cx) / span);
  const radiusAtX = (x: number) => radius(Math.min(1, Math.abs(x - cx) / span));

  // ---------- drawing primitives ----------

  function set(x: number, y: number, c: Color) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    buf[y * W + x] = U32[c];
  }

  function rect(x: number, y: number, w: number, h: number, c: Color) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, c);
  }

  // ---------- scene pieces ----------

  function drawBackdrop() {
    buf.fill(U32.paper);
    for (let y = 2; y < H; y += 6) for (let x = 2; x < W; x += 6) set(x, y, 'rule');
  }

  function drawInterior() {
    const L = cx - span;
    const R = cx + span;
    for (let x = Math.ceil(L); x <= R; x++) {
      const d = depthAt(x);
      const r = radiusAtX(x);
      for (let y = Math.ceil(cy - r + 1); y < cy + r; y++) {
        if (bayer(x, y) < 0.18 * d * d) set(x, y, 'haze');
      }
    }
  }

  function ringPositions(): number[] {
    const out: number[] = [];
    const period = 9;
    for (let k = 0; k < rings; k++) {
      const u = (k / rings + time / period) % 1;
      const s = Math.pow(1 - u, 1.5);
      out.push(-s, s);
    }
    return out;
  }

  function drawRings(front: boolean) {
    for (const s of ringPositions()) {
      if (Math.abs(s) < 0.015) continue;
      const a = cx + s * span;
      const ry = radius(s);
      const rx = radiusX(s);
      const d = 1 - Math.abs(s);
      const side = Math.sign(s);
      const steps = Math.ceil(Math.PI * 2 * Math.max(ry, rx) * 1.6);
      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const ct = Math.cos(t);
        const isFront = ct * side > 0 || side === 0;
        if (isFront !== front) continue;
        const x = Math.round(a + rx * ct);
        const y = Math.round(cy + ry * Math.sin(t));
        const b = bayer(x, y);
        if (front) set(x, y, b < 0.2 + 0.8 * d ? 'signal' : 'ember');
        else if (b < 0.25 + 0.6 * d) set(x, y, 'ember');
        else if (b < 0.85) set(x, y, 'haze');
      }
    }
  }

  function drawLaptop(x: number, side: Side) {
    const y = laptopY;
    // lid
    rect(x + 2, y, LAPTOP_W - 4, 1, 'ink');
    rect(x + 2, y + 14, LAPTOP_W - 4, 1, 'ink');
    rect(x + 2, y, 1, 15, 'ink');
    rect(x + LAPTOP_W - 3, y, 1, 15, 'ink');
    rect(x + 3, y + 1, LAPTOP_W - 6, 13, 'paper');
    // base
    rect(x, y + 15, LAPTOP_W, 1, 'ink');
    rect(x + 1, y + 16, LAPTOP_W - 2, 1, 'stone');
    // screen text
    const lines = screens[side];
    lines.forEach((line, i) => {
      const c: Color = line.hot > 0 ? 'signal' : 'stone';
      for (let k = 0; k < line.len; k++) if ((k + 1) % 5 !== 0) set(x + 5 + k, y + 3 + i * 3, c);
    });
    // cursor
    if (Math.floor(time * 2) % 2 === 0 || reduced.matches) {
      const row = Math.min(lines.length, 3);
      rect(x + 5, y + 2 + row * 3, 2, 2, side === 0 ? 'signal' : 'ink');
    }
  }

  function packetY(p: Packet) {
    const r = radiusAtX(p.x);
    return cy + Math.sin(p.phase + p.x * 0.11) * r * 0.32;
  }

  function drawPackets() {
    for (const p of packets) {
      p.trail.forEach((t, i) => {
        if (bayer(t.x | 0, t.y | 0) < 1 - (i + 1) / (p.trail.length + 1)) set(t.x, t.y, p.color);
      });
      const y = packetY(p);
      const scale = radiusAtX(p.x) / rMouth;
      const size = Math.max(1, Math.round(p.size * (0.4 + 0.6 * scale)));
      rect(Math.round(p.x - size / 2), Math.round(y - size / 2), size, size, p.color);
    }
  }

  function draw() {
    drawBackdrop();
    drawInterior();
    drawRings(false);
    drawPackets();
    drawRings(true);
    drawLaptop(leftX, 0);
    drawLaptop(rightX, 1);
    ctx.putImageData(image, 0, 0);
  }

  // ---------- simulation ----------

  function pushLine(side: Side, len: number, hot: number) {
    const lines = screens[side];
    lines.push({ len, hot });
    while (lines.length > 4) lines.shift();
  }

  function launch(dir: 1 | -1, opts: Partial<Packet> = {}): Packet {
    const startX = dir === 1 ? leftX + LAPTOP_W - 2 : rightX + 1;
    return {
      dir,
      x: startX,
      phase: Math.random() * Math.PI * 2,
      size: 2,
      color: dir === 1 ? 'signal' : 'ink',
      trail: [],
      last: false,
      ...opts,
    };
  }

  function sendNext() {
    const msg = script[scriptIndex % script.length];
    scriptIndex++;
    const dir = msg.from === 0 ? 1 : -1;
    const count = Math.min(5, 2 + Math.ceil(msg.text.length / 16));
    for (let i = 0; i < count; i++) {
      queued.push({
        at: time + i * 0.12,
        packet: launch(dir, { msg, last: i === count - 1 && !msg.file }),
      });
    }
    if (msg.file) {
      queued.push({ at: time + count * 0.12 + 0.1, packet: launch(dir, { msg, size: 4, last: true }) });
    }
    inFlight++;
    pushLine(msg.from, Math.min(15, 5 + Math.round(msg.text.length / 4)), 0);
    events.onSend?.(msg);
  }

  function update(dt: number) {
    time += dt;

    if (inFlight === 0 && time >= nextSendAt) sendNext();

    queued = queued.filter((q) => {
      if (q.at > time) return true;
      packets.push(q.packet);
      return false;
    });

    const travel = rightX - leftX - LAPTOP_W;
    const base = travel / 1.5;
    packets = packets.filter((p) => {
      p.trail.unshift({ x: p.x, y: packetY(p) });
      if (p.trail.length > 6) p.trail.pop();
      const d = depthAt(p.x);
      p.x += p.dir * base * (1 + 1.4 * d * d) * dt;
      const arrived = p.dir === 1 ? p.x >= rightX + 3 : p.x <= leftX + LAPTOP_W - 3;
      if (!arrived) return true;
      if (p.last && p.msg) {
        const to: Side = p.dir === 1 ? 1 : 0;
        pushLine(to, Math.min(15, 5 + Math.round(p.msg.text.length / 4)), 0.9);
        inFlight = Math.max(0, inFlight - 1);
        nextSendAt = time + 1.6;
        events.onDeliver?.(p.msg);
      }
      return false;
    });

    for (const lines of screens) for (const l of lines) l.hot = Math.max(0, l.hot - dt);
  }

  // A still frame that shows the idea without motion.
  function staticFrame() {
    time = 2.2;
    screens[0] = [{ len: 12, hot: 0 }, { len: 8, hot: 0 }];
    screens[1] = [{ len: 10, hot: 0 }, { len: 13, hot: 0.5 }];
    const span2 = rightX - leftX - LAPTOP_W;
    packets = [0.18, 0.27, 0.36, 0.62, 0.71].map((f, i) => {
      const dir: 1 | -1 = i < 3 ? 1 : -1;
      return { ...launch(dir), x: leftX + LAPTOP_W + span2 * f, phase: i * 1.7 };
    });
    events.onSend?.(script[0]);
    draw();
  }

  // ---------- loop ----------

  let raf = 0;
  let last = 0;
  let acc = 0;
  let visible = true;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    acc += now - last;
    last = now;
    if (acc < 1000 / FPS) return;
    const dt = Math.min(acc, 120) / 1000;
    acc = 0;
    update(dt);
    draw();
  }

  function start() {
    cancelAnimationFrame(raf);
    if (!ready) return;
    if (reduced.matches) {
      staticFrame();
      return;
    }
    if (!visible || document.hidden) return;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(raf);
  }

  layout();
  start();

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    visible ? start() : stop();
  }).observe(canvas);

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduced.addEventListener('change', start);

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const before = ready ? W * px : 0;
      if (ready && Math.abs(canvas.parentElement!.clientWidth - before) < px) return;
      const wasReady = ready;
      if (!layout()) return;
      packets = [];
      queued = [];
      inFlight = 0;
      nextSendAt = time + 0.4;
      if (!wasReady) start();
      else reduced.matches ? staticFrame() : draw();
    }, 120);
  }).observe(canvas.parentElement!);

  // Clicking a side sends a packet from that machine.
  canvas.addEventListener('pointerdown', (e) => {
    if (reduced.matches) return;
    const box = canvas.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const dir: 1 | -1 = x < W / 2 ? 1 : -1;
    for (let i = 0; i < 3; i++) queued.push({ at: time + i * 0.08, packet: launch(dir) });
  });
}
