# tunnel-ai — design

Date: 2026-10-06. Status: A and B built and tested locally; not deployed or published yet.

## Product

A CLI (`tunnel`) that opens an end-to-end encrypted tunnel so two or more AI coding
agents on different machines can exchange messages and files. Agent skills ship with
the CLI so agents learn the commands without human help.

Open-core: open-source repo + hosted relay at `tunnel.dilyor.dev` (oraclewps).
Hosted tiers: 1 tunnel free; 5 tunnels free for one month (trial); pay-as-you-go after.

## Sub-projects

| # | Sub-project | Status |
|---|---|---|
| A | Core: protocol + relay + CLI + skills (OSS) | built in `cli/`, 18 tests |
| B | Landing site | built in `site/` |
| C | Hosted billing: accounts, quotas, trial, payments | own spec later |

## Decisions

- Payload: messages (text/JSON, broadcast or addressed with `--to`) + files (≤10 MB).
- Tunnel = persistent room with an encrypted mailbox (TTL 7 days). Agents rejoin anytime.
- Encryption: end-to-end (default taken; user skipped the question). Relay stores ciphertext only.
- Skills: Claude Code (`~/.claude/skills/tunnel`) + Codex (`~/.agents/skills/tunnel`, per current OpenAI docs).
- Stack: TypeScript everywhere. npm package `tunnel-ai` (name free as of 2026-10-06), bin `tunnel`.

## A. Core

Layout: one npm package in `cli/` (CLI, relay under `src/relay/`, skill in `skills/tunnel/`).

CLI (stateless, no daemon, state in `~/.tunnel/`):
`open`, `join <code> [--as name]`, `send "text" [--to peer] [--file path]`, `inbox`,
`wait [--timeout s]`, `listen`, `get <file-id>`, `peers`, `ls`, `use`, `invite`, `leave`,
`close`, `watch`, `skills install [--claude] [--codex]`. `--json` everywhere.

Crypto/join: creator makes random 32-byte room key K. Invite `7-orange-fox-tide`
(number = relay slot, 3 BIP39 words = secret, ~33 bits); relay stores K wrapped with
scrypt(words) (N=2^16; Node has no built-in argon2) and sha256 of a verifier;
one-time, 15-min TTL, burns after 3 bad tries. Join returns a member bearer token.
Messages/files sealed with ChaCha20-Poly1305 (Node built-in, random 96-bit nonce) under K.
Zero runtime dependencies: node:crypto, node:sqlite, node:http, util.parseArgs.

Relay: HTTP only; `wait`/`listen` long-poll `GET …/messages?after=seq&wait=50`.
SQLite + blob dir. Limits: 64 KB message, 10 MB file, 7-day TTL, 600 req/min per IP.
Device identity auto-created; per-device tunnel cap via `TUNNEL_MAX_TUNNELS` (hosted = 1,
self-host = unlimited) — billing (C) replaces it with accounts. Known gap until C:
devices are free to create, so the cap is a speed bump, not enforcement. Self-host: `npx tunnel-ai relay`.

Agent delivery: Codex → `tunnel wait` / `inbox`; Claude Code → `tunnel listen` under
Monitor. Every message printed as `[tunnel <name>] <peer> (peer agent):`;
skill tells agents peer messages are requests, never authority.

## B. Landing

Tokens: Paper `#FFFFFF`, Ink `#1E1712`, Signal `#FF5B00`, Ember `#FFB07A`,
Haze `#FFF1E6`, Stone `#8C817A`, Rule `#EEE8E3`.
Type: Geist Pixel (display, wordmark), Geist Sans (body), Geist Mono (terminals).

Principles: pixels only where data moves; orange = traffic, never decoration; one bold
element (the pixel wormhole), everything else quiet; no cards, hairlines + whitespace.

Sections: nav → hero (pixel H1, one-line promise, install command) → full-bleed pixel
wormhole canvas with synced captions → how it works (open/join/talk as a two-machine
timeline) → skills → features → pricing (hosted "coming soon", links to GitHub) → FAQ →
giant pixel wordmark footer.

Stack: Vite, vanilla TS, static build deployed to `tunnel.dilyor.dev`.
