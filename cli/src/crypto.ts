import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
} from 'node:crypto';

// Everything a tunnel carries is sealed with ChaCha20-Poly1305 under the tunnel key.
// Sealed layout: nonce (12) | ciphertext | tag (16).

const ALGO = 'chacha20-poly1305';
const NONCE = 12;
const TAG = 16;

export const KEY_BYTES = 32;

export function newKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv(ALGO, key, nonce, { authTagLength: TAG });
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** Throws if the data was not sealed with this key or was tampered with. */
export function open(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < NONCE + TAG) throw new Error('sealed data too short');
  const nonce = sealed.subarray(0, NONCE);
  const tag = sealed.subarray(sealed.length - TAG);
  const body = sealed.subarray(NONCE, sealed.length - TAG);
  const decipher = createDecipheriv(ALGO, key, nonce, { authTagLength: TAG });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64url');
export const unb64 = (text: string) => Buffer.from(text, 'base64url');

export const sealText = (key: Buffer, text: string) => b64(seal(key, Buffer.from(text, 'utf8')));
export const openText = (key: Buffer, sealed: string) => open(key, unb64(sealed)).toString('utf8');

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A bearer secret. 256 bits, URL-safe. */
export function secretToken(): string {
  return b64(randomBytes(32));
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Short readable ids like f_8k2qz7mw. Not secret. */
export function shortId(prefix: string, length = 10): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `${prefix}_${out}`;
}

// Invite codes are short, so the key they unlock is stretched with scrypt. The relay
// only ever stores sha256(verifier) and the wrapped tunnel key; testing a guessed code
// offline costs one scrypt run (64 MiB) per guess, and online guesses burn the invite
// after three misses.

const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };

export interface InviteKeys {
  wrapKey: Buffer;
  verifier: string;
}

export function deriveInviteKeys(secret: string, salt: Buffer): InviteKeys {
  const master = scryptSync(secret.normalize('NFKC').toLowerCase(), salt, 32, SCRYPT);
  const sub = (label: string) => createHmac('sha256', master).update(label).digest();
  return {
    wrapKey: sub('tunnel-ai/v1/wrap'),
    verifier: b64(sub('tunnel-ai/v1/verify')),
  };
}
