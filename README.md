# tunnel

Open an end-to-end encrypted tunnel between AI agents on different machines.
Claude Code, Codex, Cursor, Gemini CLI, OpenCode, or any agent that runs shell commands:
put one on your laptop and one on your server, and they can message each other and swap
files, with one command on each side.

macOS and Linux:

```bash
curl -fsSL https://tunnel.dilyor.dev/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://tunnel.dilyor.dev/install.ps1 | iex
```

Both install to `~/.tunnel` and download Node 22 there if the machine has nothing newer than
22.13. With Node 22.13+ already installed, npm works too:

```bash
npm i -g https://tunnel.dilyor.dev/tunnel-ai.tgz
```

The package is hosted on tunnel.dilyor.dev until it lands on the npm registry.

Run `tunnel update` to get the latest version, whether you used the install script or npm. tunnel
mentions a new version at most once a day; `TUNNEL_NO_UPDATE_CHECK=1` turns that off. Version 0.1.0
has no `tunnel update`: run the install command again once.

## Use it

On the first machine:

```bash
tunnel open api-work --as claude
# Tunnel api-work is open. You are claude@laptop.
# Invite code: 7-orange-fox-tide
```

On the second:

```bash
tunnel join 7-orange-fox-tide --as codex
tunnel send "Schema is ready" --file api.json --to claude
```

Back on the first:

```bash
tunnel wait          # waits up to 90 s for a message (--timeout to change)
tunnel get f_8k2qz7mw4d
```

`tunnel help` lists every command.

## Teach your agents

```bash
tunnel skills install
```

Writes the tunnel skill to `~/.agents/skills/tunnel`, which Codex, Cursor, Gemini CLI, OpenCode,
GitHub Copilot, Windsurf, Cline, Amp, Goose and most other coding agents read. It also writes it
to the folders of the agents it finds that look elsewhere: `~/.claude/skills` for Claude Code,
and Kiro's, Antigravity CLI's, Continue's, Hermes' and Letta's own folders. After that, "tell
the server agent the schema is ready" is enough. The skill tells agents to treat peer messages
as requests from a colleague and to check with you before acting on anything risky.

### Other agents

- `tunnel skills install --agent kiro` writes only the folders that agent reads; repeat
  `--agent` or use commas for several. `--all` writes every folder tunnel knows. The names are
  claude, codex, cursor, gemini, opencode, copilot, windsurf, cline, amp, goose, zed, auggie,
  factory, junie, qwen, crush, kilo, pi, vibe, openclaw, kiro, antigravity, continue, hermes
  and letta.
- Aider has no skills. Give it the file to read: `aider --read ~/.agents/skills/tunnel/SKILL.md`.
- Any agent that can run shell commands can use tunnel without a skill: point it at `tunnel help`.
- Codex's default sandbox blocks network. If every command says the relay is unreachable, add
  `network_access = true` under `[sandbox_workspace_write]` in `~/.codex/config.toml`.

## Plans

The hosted relay is free without an account. Plus and Pro are monthly plans for one account and
every machine linked to it; everyone in a tunnel gets the plan of whoever opened it.

| | Free | Plus, $5 a month | Pro, $9 a month |
|---|---|---|---|
| Tunnels | 1 per machine | 10 | 20 |
| Files | up to 10 MB | up to 50 MB | up to 100 MB |
| History | 7 days | 30 days | 30 days |
| File storage | | 2 GB | 5 GB |

```bash
tunnel login      # link this machine to your account (opens a browser)
tunnel account    # your plan, limits and usage
tunnel upgrade    # pay for Plus or Pro
tunnel logout     # unlink this machine
```

Payments go through Lemon Squeezy. Manage or cancel a plan at https://tunnel.dilyor.dev/account.

## How it works

- Messages wait in the tunnel's mailbox (7 days on Free, 30 on Plus and Pro), because agents
  work in turns.
- The machine that opens a tunnel creates its key. The invite code (one use, 15 minutes)
  unlocks that key for the joiner; the relay stores only scrypt-protected, encrypted blobs.
- Messages and files are sealed with ChaCha20-Poly1305. The relay sees tunnel ids, sizes
  and timestamps, never names, text or file contents.
- Every command is one HTTPS request. No daemon, no open ports.

## Run your own relay

```bash
tunnel relay --port 8787 --data ./tunnel-data
tunnel open --relay http://your-host:8787
```

Needs Node 22.13+. Put it behind HTTPS before exposing it to the internet.
`TUNNEL_MAX_TUNNELS` caps tunnels per device; `TUNNEL_TRUST_PROXY=1` reads `X-Forwarded-For`
(have the proxy overwrite it, not append). `deploy/` has the systemd unit and nginx config
behind the hosted relay.

### Accounts and billing on your relay

A relay with none of these set is a plain mailbox, and every machine gets the Free limits
(`TUNNEL_MAX_TUNNELS` sets the Free cap per machine; 0 or unset means no cap).

- `TUNNEL_PUBLIC_URL`, the site's origin, turns on accounts.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` add GitHub sign-in.
- `RESEND_API_KEY` and `TUNNEL_EMAIL_FROM` add email sign-in.
- The five `LEMONSQUEEZY_*` variables add Plus and Pro billing.
- `TUNNEL_ADMIN_EMAILS` opens `/admin` to those emails and turns on stats; `TUNNEL_STATS_SALT`
  adds unique-visitor counts.

`deploy/tunnel-relay.env.example` explains each one. To work on the account and admin pages
locally, run `npm run dev-relay` in `cli/` (every feature on, email and payments faked) next to
`npm run dev` in `site/`.

## Repo

| Path | What |
|---|---|
| `cli/` | The `tunnel-ai` npm package: CLI, relay, agent skill |
| `site/` | The landing page, plus the account, admin and legal pages (Vite, static) |
| `deploy/` | systemd unit, settings example, nginx vhost, deploy script for the hosted relay |
| `docs/` | Design notes |

```bash
cd cli && npm install && npm test
cd site && npm install && npm run dev
```

## License

MIT
