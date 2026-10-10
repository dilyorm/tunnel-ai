# Backlog

## Scheduled for 2026-10-09

> Superseded by `superpowers/specs/2026-10-09-accounts-billing-stats-design.md` (approved design). Decisions there win where they differ: Lemon Squeezy instead of Stripe, flat Plus $5 and Pro $9 plans, our own cookieless stats instead of Umami, and no `/agents` page (just a hint line). The notes below are the original brief.

### 1. Visitor and usage stats

**Goal:** know who visits tunnel.dilyor.dev, what they do there, and how the hosted relay gets used.

**Site analytics**
- Track pageviews, referrers, countries and devices.
- Track these events:
  - install tab picked (unix / windows / npm)
  - copy clicked, for each command
  - FAQ item opened
  - pricing viewed
  - GitHub and other outbound clicks
- Recommendation: self-host Umami or GoatCounter on oraclewps.
  - Both are cookieless, so the site needs no consent banner.
  - Neither does session replay.
  - That fits the "no telemetry" position against Pilot (see `competitive/2026-10-08-pilot-protocol.md`).

**Install funnel**
- nginx access logs already record downloads of `install.sh`, `install.ps1` and `tunnel-ai.tgz`. Count them per day with goaccess or a small script.
- Funnel: copy click → script download → device created on the relay.

**Relay stats** (aggregates only; the relay sees nothing but ciphertext)
- devices created per day
- active devices over 7 days
- tunnels opened
- joins
- messages
- file bytes
- CLI version mix

To get the version mix, check whether the CLI sends a version header. If it doesn't, add `User-Agent: tunnel-ai/<version>`.

Expose the numbers as a token-protected `GET /v1/admin/stats` or a nightly query. Store no message content and no IPs beyond the in-memory rate limiter.

**Privacy note:** add a short section to the site and README covering what is counted and what is never collected.

### 2. Accounts and pay-as-you-go (sub-project C in the spec)

**Goal:** a user who already has a device and open tunnels signs in, pays, and moves from the free tier (1 tunnel) to pay-as-you-go without losing anything.

**Sign-in**
- `tunnel login` runs a device-code flow:
  1. The CLI prints a URL and a code.
  2. The user signs in at tunnel.dilyor.dev/login and approves.
  3. The relay links the device id to the account.
- Also add `tunnel logout` and `tunnel account`, which shows plan, usage and devices.
- Login stays optional: anonymous devices keep working on the free tier.

**Accounts**
- An account can own several devices.
- The tunnel quota counts per account. This replaces `TUNNEL_MAX_TUNNELS` per device and closes the "devices are free to create" gap.
- New relay tables: accounts, account_devices, subscriptions, usage counters.
- Enforce limits when a tunnel is opened or joined.

**Web**
- tunnel.dilyor.dev/account shows plan, usage and devices, and links to the billing portal.

**Payments**
- Checkout starts from `tunnel upgrade` (opens the browser) or from the account page.
- Provider webhooks set the plan state and must be signature-verified.

**Trial:** 5 tunnels for one month on first login, per the spec.

**Security**
- OAuth and provider secrets live only in the server's environment.
- Session and device tokens are hashed at rest.

**Process:** brainstorm → spec (`superpowers/specs/2026-10-09-billing-design.md`) → plan → build.

### 3. Install by telling your agent

**Goal:** the user installs nothing by hand. They paste a short sentence into Claude Code, Codex or any agent with a shell, and the agent installs tunnel, sets it up, and reports back.

**The sentence on the site:** "Install tunnel from tunnel.dilyor.dev/agents and set it up."
- Show it as the first install tab, "Ask your agent", next to curl, PowerShell and npm, with a copy button.
- Put the same sentence in the README.

**`/agents` page** (plain Markdown, also linked from `llms.txt`), written so an agent can follow it step by step:
1. Detect the OS. Run `curl -fsSL https://tunnel.dilyor.dev/install.sh | sh` or `irm https://tunnel.dilyor.dev/install.ps1 | iex`.
2. The agent's current shell won't see the new PATH entry, so call `~/.tunnel/bin/tunnel` (Windows: `%USERPROFILE%\.tunnel\bin\tunnel.cmd`) by full path the first time.
3. Run `tunnel --version` to verify the install.
4. Run `tunnel skills install` so the agent learns the commands. Read the installed `SKILL.md`, or run `tunnel help`, in the same session, because the new skill may not load until a restart.
5. Ask the user whether to open a tunnel now. If yes, run `tunnel open`, hand over the invite code, and explain that the other machine's agent gets told "join tunnel `<code>`".
6. Report what changed: files in `~/.tunnel`, one PATH line, the skill folder.

**Rules for the page:** tell the agent to show the user each command before running it. Never write to `CLAUDE.md` or `AGENTS.md`. This is the consent contrast with Pilot's automatic skill injection.

**The other machine:** "Join tunnel `7-orange-fox-tide` from tunnel.dilyor.dev/agents" should work the same way: install if missing, then `tunnel join`.

**Test:** in clean Ubuntu and Windows environments, paste only the sentence into Claude Code and into Codex, and confirm each ends with a working `tunnel` and the skill installed.

### Decide before building

1. **Sign-in method:** GitHub OAuth, email magic link, or both?
2. **Payment provider:** Stripe only if it supports your country. Otherwise use a merchant of record (Paddle, Lemon Squeezy or Polar), which also handles VAT.
3. **What pay-as-you-go charges for.** Pilot's public network is free and unmetered, so charging per extra tunnel is a weak offer. Candidates:
   - active tunnel-months
   - longer retention than 7 days
   - files over 10 MB
   - a private team relay
4. **Analytics:** self-hosted Umami (recommended) or Plausible cloud?

## Ideas, not scheduled

- **Use-case pages for search:** Claude Code ↔ Codex, laptop ↔ server, handing off build artefacts.
- **`tunnel mcp` mode:** so Claude Desktop, Cursor and ChatGPT can use tunnel without a shell.
- **More skill targets** for `tunnel skills install`: Cursor, Goose, OpenHands. Only installed when the user asks.
- **Threat-model page:** what the relay sees and what it can't.
- **T3 Code guide:** how to link agents in two T3 Code environments with tunnel. T3 Code's agent messaging only works within one machine (checked 2026-10-08).
- **After the npm publish (~2026-10-09):** switch the landing page and README back to `npm i -g tunnel-ai`.
