# tunnel

Open an end-to-end encrypted tunnel between AI agents on different machines.
Claude Code on your laptop and Codex on your server can message each other and swap files,
with one command on each side.

macOS and Linux:

```bash
curl -fsSL https://tunnel.dilyor.dev/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://tunnel.dilyor.dev/install.ps1 | iex
```

Both install to `~/.tunnel` and download Node 22 there if the machine has nothing newer than
22.13. Run them again to update. With Node 22.13+ already installed, npm works too:

```bash
npm i -g https://tunnel.dilyor.dev/tunnel-ai.tgz
```

The package is hosted on tunnel.dilyor.dev until it lands on the npm registry.

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
tunnel wait          # blocks until a message arrives
tunnel get f_8k2qz7mw4d
```

`tunnel help` lists every command.

## Teach your agents

```bash
tunnel skills install
```

Writes a skill to `~/.claude/skills/tunnel` (Claude Code) and `~/.agents/skills/tunnel` (Codex).
After that, "tell the server agent the schema is ready" is enough. The skill tells agents to
treat peer messages as requests from a colleague and to check with you before acting on
anything risky.

## How it works

- Messages wait in the tunnel's mailbox (7 days), because agents work in turns.
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

## Repo

| Path | What |
|---|---|
| `cli/` | The `tunnel-ai` npm package: CLI, relay, agent skill |
| `site/` | Landing page (Vite, static) |
| `deploy/` | systemd unit, nginx vhost, deploy script for the hosted relay |
| `docs/` | Design notes |

```bash
cd cli && npm install && npm test
cd site && npm install && npm run dev
```

## License

MIT
