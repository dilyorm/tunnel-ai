import { randomInt } from 'node:crypto';
import { UsageError } from './errors.js';
import { WORDS } from './wordlist.js';

// Invite code: <slot>-<word>-<word>-<word>, e.g. 7-orange-fox-tide.
// The slot tells the relay which invite to look up. The words are the secret (~33 bits).

export const CODE_WORDS = 3;

const KNOWN = new Set(WORDS);

export function randomSecret(): string {
  return Array.from({ length: CODE_WORDS }, () => WORDS[randomInt(WORDS.length)]).join('-');
}

export const formatCode = (slot: number, secret: string) => `${slot}-${secret}`;

export interface ParsedCode {
  slot: number;
  secret: string;
}

export function parseCode(input: string): ParsedCode {
  const parts = input.trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
  const [slot, ...words] = parts;
  if (!slot || !/^\d{1,5}$/.test(slot) || words.length !== CODE_WORDS) {
    throw new UsageError(`"${input}" is not an invite code. Codes look like 7-orange-fox-tide.`);
  }
  const unknown = words.find((w) => !KNOWN.has(w));
  if (unknown) {
    throw new UsageError(`"${unknown}" is not a word used in invite codes. Check the spelling.`);
  }
  return { slot: Number(slot), secret: words.join('-') };
}
