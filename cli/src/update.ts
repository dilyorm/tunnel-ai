import { DEFAULT_RELAY } from './commands.js';
import { isNewer } from './version.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where releases come from: the hosted site, or $TUNNEL_DOWNLOAD (the installers read the same variable). */
export function updateBase(env: NodeJS.ProcessEnv): string {
  return (env.TUNNEL_DOWNLOAD || DEFAULT_RELAY).replace(/\/+$/, '');
}

export interface HintInput {
  command: string;
  /** The version the release relay reported during this run, if the run talked to it. */
  seen?: string;
  current: string;
  now: number;
  /** config.json's updateHintAt, unchecked: people edit that file by hand. */
  lastHintAt?: unknown;
  /** TUNNEL_NO_UPDATE_CHECK=1. */
  optOut: boolean;
}

/** The once-a-day line saying a newer tunnel is out, or undefined when there is nothing to say. */
export function updateHint(input: HintInput): string | undefined {
  if (input.optOut || input.command === 'update' || input.command === 'relay') return undefined;
  if (!input.seen || !isNewer(input.seen, input.current)) return undefined;
  const last = input.lastHintAt;
  // Stale means more than a day old, so exactly 24 hours still counts as shown.
  // A time in the future means the clock moved back: treat it as stale, like a missing one.
  if (typeof last === 'number' && last <= input.now && input.now - last <= DAY_MS) return undefined;
  return `tunnel ${input.seen} is out (you have ${input.current}). Run \`tunnel update\` to get it.`;
}
