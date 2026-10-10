import { join } from 'node:path';
import { UsageError } from './errors.js';

// The coding agents `tunnel skills install` knows. For each: where it keeps its settings (a marker that
// it is installed) and the skill folders it reads. Most read the shared ~/.agents/skills. Adding an
// agent is one row.

export interface Agent {
  /** The --agent value. */
  name: string;
  label: string;
  /** The agent counts as installed when any of these exists. */
  markers: string[];
  /** Skill folders it reads. The skill goes in <folder>/tunnel/SKILL.md. */
  folders: string[];
}

export interface Places {
  home: string;
  /** $XDG_CONFIG_HOME, else ~/.config. */
  config: string;
  /** ~/.agents/skills, read by most agents. */
  shared: string;
  copilotHome?: string;
}

/** The folders agents keep their settings and skills in, for this environment and home folder. */
export function places(env: NodeJS.ProcessEnv, home: string): Places {
  return {
    home,
    config: env.XDG_CONFIG_HOME || join(home, '.config'),
    shared: join(home, '.agents', 'skills'),
    copilotHome: env.COPILOT_HOME || undefined,
  };
}

/** Every agent tunnel can install its skill for, in the order `--agent` errors list them. */
export function knownAgents(p: Places): Agent[] {
  const { home, config, shared, copilotHome } = p;
  const own = (...parts: string[]) => join(home, ...parts);
  const sharedOnly = (name: string, label: string, ...markers: string[]): Agent => ({ name, label, markers, folders: [shared] });
  const ownFolder = (name: string, label: string, ...parts: string[]): Agent => ({
    name,
    label,
    markers: [own(...parts)],
    folders: [own(...parts, 'skills')],
  });
  return [
    ownFolder('claude', 'Claude Code', '.claude'),
    sharedOnly('codex', 'Codex', own('.codex')),
    sharedOnly('cursor', 'Cursor', own('.cursor')),
    sharedOnly('gemini', 'Gemini CLI', own('.gemini')),
    sharedOnly('opencode', 'OpenCode', join(config, 'opencode')),
    {
      name: 'copilot',
      label: 'GitHub Copilot',
      markers: [copilotHome ?? own('.copilot')],
      // Copilot CLI stops reading the shared folder when COPILOT_HOME is set; Copilot in VS Code still reads it.
      folders: copilotHome ? [shared, join(copilotHome, 'skills')] : [shared],
    },
    sharedOnly('windsurf', 'Windsurf', own('.codeium', 'windsurf'), join(config, 'devin')),
    sharedOnly('cline', 'Cline', own('.cline')),
    sharedOnly('amp', 'Amp', join(config, 'amp')),
    sharedOnly('goose', 'Goose', join(config, 'goose')),
    sharedOnly('zed', 'Zed', join(config, 'zed')),
    sharedOnly('auggie', 'Auggie', own('.augment')),
    sharedOnly('factory', 'Factory', own('.factory')),
    sharedOnly('junie', 'Junie', own('.junie')),
    sharedOnly('qwen', 'Qwen Code', own('.qwen')),
    sharedOnly('crush', 'Crush', join(config, 'crush')),
    sharedOnly('kilo', 'Kilo Code', own('.kilo')),
    sharedOnly('pi', 'Pi', own('.pi')),
    sharedOnly('vibe', 'Mistral Vibe', own('.vibe')),
    sharedOnly('openclaw', 'OpenClaw', own('.openclaw')),
    ownFolder('kiro', 'Kiro', '.kiro'),
    ownFolder('antigravity', 'Antigravity CLI', '.gemini', 'antigravity-cli'),
    ownFolder('continue', 'Continue', '.continue'),
    ownFolder('hermes', 'Hermes', '.hermes'),
    ownFolder('letta', 'Letta', '.letta'),
  ];
}

/** Which folders a run writes: the detected agents (default), every folder (--all), or the named agents (--agent). */
export type Choice = { mode: 'detect' } | { mode: 'all' } | { mode: 'named'; names: string[] };

export interface Target {
  /** A skill folder, e.g. ~/.agents/skills. */
  folder: string;
  /** Agents to name beside it in the output. */
  labels: string[];
}

/**
 * The folders to write, shared folder first, each with the agents to name beside it. The shared line
 * names detected agents (or, with --agent, the named ones); an agent's own folder names its agent.
 */
export function chooseTargets(agents: Agent[], p: Places, choice: Choice, exists: (path: string) => boolean): Target[] {
  let picked: Agent[];
  let onShared: Agent[];
  if (choice.mode === 'named') {
    picked = [...new Set(choice.names)].map((name) => {
      const found = agents.find((a) => a.name === name);
      if (!found) throw new UsageError(`Unknown agent "${name}". Known agents: ${agents.map((a) => a.name).join(', ')}.`);
      return found;
    });
    onShared = picked;
  } else {
    const detected = agents.filter((a) => a.markers.some((m) => exists(m)));
    picked = choice.mode === 'all' ? agents : detected;
    onShared = detected;
  }
  const folders = choice.mode === 'named' ? [] : [p.shared];
  for (const agent of picked) for (const folder of agent.folders) if (!folders.includes(folder)) folders.push(folder);
  folders.sort((a, b) => Number(b === p.shared) - Number(a === p.shared));
  return folders.map((folder) => ({
    folder,
    labels: (folder === p.shared ? onShared : picked).filter((a) => a.folders.includes(folder)).map((a) => a.label),
  }));
}
