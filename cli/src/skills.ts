import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseTargets, knownAgents, places, type Choice, type Places, type Target } from './agents.js';
import type { Ctx } from './commands.js';
import { TunnelError, UsageError } from './errors.js';

const USAGE = 'Usage: tunnel skills install [--agent name]... [--all] [--refresh]';
/** A SKILL.md that tunnel wrote, in any line-ending style. */
const OURS = /^---\r?\nname: tunnel\r?\n/;

/** Install the tunnel skill for the coding agents on this machine. Copies, never symlinks (Windows needs admin for those). */
export async function skillsCmd(ctx: Ctx, args: string[]) {
  if (args[0] !== 'install') throw new UsageError(USAGE);
  const names = [
    ...(ctx.flags.agent ?? []).flatMap((value) => value.split(',')),
    ...(ctx.flags.claude ? ['claude'] : []),
    ...(ctx.flags.codex ? ['codex'] : []),
  ]
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if ([names.length > 0, ctx.flags.all, ctx.flags.refresh].filter(Boolean).length > 1) {
    throw new UsageError(`Use one of --agent, --all and --refresh at a time.\n${USAGE}`);
  }

  const home = ctx.env.TUNNEL_SKILLS_HOME || homedir();
  const p = places(ctx.env, home);
  const agents = knownAgents(p);
  const skill = readFileSync(fileURLToPath(new URL('../skills/tunnel/SKILL.md', import.meta.url)), 'utf8');

  let targets: Target[];
  if (ctx.flags.refresh) {
    targets = chooseTargets(agents, p, { mode: 'all' }, existsSync).filter((t) => isOurs(join(t.folder, 'tunnel', 'SKILL.md')));
    if (!targets.length) {
      ctx.out(ctx.flags.json ? JSON.stringify({ installed: [] }) : 'No installed tunnel skills to refresh.');
      return;
    }
  } else {
    const choice: Choice = names.length ? { mode: 'named', names } : ctx.flags.all ? { mode: 'all' } : { mode: 'detect' };
    targets = chooseTargets(agents, p, choice, existsSync);
  }

  const dirs = targets.map((t) => join(t.folder, 'tunnel'));
  for (const dir of dirs) write(dir, skill);

  if (ctx.flags.json) {
    ctx.out(JSON.stringify({ installed: targets.map((t, i) => ({ dir: dirs[i], agents: t.labels })) }));
    return;
  }
  const shown = dirs.map((dir) => pretty(dir, home));
  const width = Math.max(...shown.map((s) => s.length));
  ctx.out(ctx.flags.refresh ? 'Refreshed the tunnel skill:' : 'Installed the tunnel skill:');
  targets.forEach((t, i) => ctx.out(`  ${shown[i].padEnd(width)}   ${describe(t, p, home, names.length > 0)}`));
}

function isOurs(file: string): boolean {
  try {
    return OURS.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function write(dir: string, skill: string) {
  const file = join(dir, 'SKILL.md');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, skill);
  } catch (error) {
    throw new TunnelError(`Couldn't write ${file}: ${(error as Error).message}`);
  }
}

/** The agents named on an output line. The shared folder also covers agents tunnel doesn't know by name. */
function describe(t: Target, p: Places, home: string, named: boolean): string {
  if (t.folder !== p.shared || named) return t.labels.join(', ');
  const others = `agents that read ${pretty(p.shared, home)}`;
  return t.labels.length ? `${t.labels.join(', ')}, and other ${others}` : others;
}

/** ~/… with forward slashes for paths under the home folder, as people type them. */
function pretty(path: string, home: string): string {
  const rel = relative(home, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path;
  return '~/' + rel.split(sep).join('/');
}
