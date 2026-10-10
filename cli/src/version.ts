export const VERSION = '0.2.0';

/** True when `a` is a later x.y.z release than `b`. Anything that isn't plain x.y.z is never newer. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) ?? []).slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
