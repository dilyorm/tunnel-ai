import { open, seal, b64, unb64 } from './crypto.js';

// What a message looks like once decrypted. The relay only ever sees the sealed form.

export interface FileRef {
  id: string;
  name: string;
  size: number;
}

export interface Plain {
  v: 1;
  from: string;
  /** Addressed to one agent (by name), or null for everyone in the tunnel. */
  to: string | null;
  text: string;
  files: FileRef[];
  at: number;
}

export interface Received extends Plain {
  seq: number;
  memberId: string;
  mine: boolean;
}

export const MAX_TEXT_BYTES = 64 * 1024;

export function sealMessage(key: Buffer, message: Plain): string {
  return b64(seal(key, Buffer.from(JSON.stringify(message), 'utf8')));
}

export function openMessage(key: Buffer, ct: string): Plain | null {
  try {
    const value = JSON.parse(open(key, unb64(ct)).toString('utf8')) as Plain;
    if (value?.v !== 1 || typeof value.text !== 'string') return null;
    return { ...value, files: Array.isArray(value.files) ? value.files : [] };
  } catch {
    return null;
  }
}

/** "codex" matches "codex@server"; full names match exactly. Case-insensitive. */
export function nameMatches(wanted: string, name: string): boolean {
  const a = wanted.toLowerCase();
  const b = name.toLowerCase();
  return a === b || b.startsWith(`${a}@`);
}

/** Messages meant for this agent: from someone else, and either broadcast or addressed to it. */
export function isForMe(message: Received, me: string): boolean {
  return !message.mine && (!message.to || nameMatches(message.to, me));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(at: number, now: number): string {
  const s = Math.round((now - at) / 1000);
  if (s < 60) return '';
  if (s < 3600) return `, ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `, ${Math.round(s / 3600)} h ago`;
  return `, ${Math.round(s / 86400)} d ago`;
}

/**
 * The block an agent reads. The header says plainly that the sender is a peer agent,
 * so the reader doesn't mistake it for instructions from its own user.
 */
export function renderMessage(m: Received, tunnel: string, now = Date.now()): string {
  const who = m.mine ? `${m.from} (you` : `${m.from} (peer agent`;
  const to = m.to ? `, to ${m.to}` : '';
  const lines = [`[tunnel ${tunnel}] ${who}${to}${ago(m.at, now)}):`, m.text];
  for (const f of m.files) lines.push(`Attached ${f.name} (${formatSize(f.size)}): tunnel get ${f.id}`);
  return lines.join('\n');
}

/** One line per message, for `tunnel listen` (each line is one event for a watching agent). */
export function renderLine(m: Received, tunnel: string): string {
  const text = m.text.replace(/\r?\n/g, ' ⏎ ');
  const files = m.files.map((f) => ` [file ${f.name}: tunnel get ${f.id}]`).join('');
  const to = m.to ? ` to ${m.to}` : '';
  return `[tunnel ${tunnel}] ${m.from} (peer agent${to}): ${text}${files}`;
}
