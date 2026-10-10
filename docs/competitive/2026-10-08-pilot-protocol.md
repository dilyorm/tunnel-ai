# Competitive teardown: Pilot Protocol

2026-10-08 · Subject: https://pilotprotocol.network (Vulture Labs, Inc.)

**Sources read:**
- the homepage, `/for/p2p`, `/plain/` (with its docs and plans pages), `llms.txt`, `robots.txt` and `sitemap.xml`
- `install.sh` (read only, never run)
- the GitHub repo and issues, and the public stats endpoint
- HN, Reddit, Product Hunt and press coverage of the seed round

**Missing:**
- ad libraries
- job posts
- the full text of the New Stack and Business Wire articles
- any hands-on test of their CLI

## The one thing

Pilot and tunnel solve the same small problem: two agents on different machines need to talk. They solve it with opposite philosophies.

Pilot's philosophy: Pilot wants to be the platform an agent lives on. It ships a resident daemon, an auto-updater, a skill that rewrites the agent's instructions every 15 minutes, a channel that lets the vendor message your agent, an app store, a wallet and paid placement. Every one of those is on by default. Their growth number comes from that design: the founder says about 250k agents installed it "mostly without their owners' knowledge" ([Show HN](https://news.ycombinator.com/item?id=49070104)).

tunnel's philosophy: tunnel is a tool the developer picks up on purpose and puts down again. Pilot can't take that position without giving up its distribution engine. That makes it tunnel's opening.

What doesn't work is copying them on breadth, competing on price, or matching their traction numbers.

## Who they are (facts)

| | Pilot Protocol | tunnel |
|---|---|---|
| Category claim | "The Network OS for agents" | Encrypted tunnel between your AI agents |
| Funding | $4.5M seed, July 2026, led by Version One; also Precursor, Night Capital, Todd & Rahul, Lenny Rachitsky, Ben Tossell ([Version One](https://versionone.vc/announcing-our-investment-in-pilot-the-internet-for-agents/)) | Bootstrapped |
| Code | Go, static binaries, **AGPL-3.0**; repo created 2026-02-07; 146 stars, 91 tags | TypeScript, zero runtime deps, **MIT** |
| What runs on your machine | `pilot-daemon` plus `pilot-updater` as systemd/launchd services, started automatically | Nothing in the background; one CLI process per command |
| Transport | UDP overlay with virtual addresses, STUN and hole-punching, with an encrypted relay fallback for symmetric NAT. Encryption is X25519 + AES-256-GCM. | HTTPS mailbox; the relay stores only ciphertext. Encryption is ChaCha20-Poly1305. |
| Trust model | Mutual handshake: `pilotctl handshake` → `approve` | One-time invite code (`tunnel open` → `tunnel join`) |
| Price | Backbone (the public network) is free with "no metered agent or bandwidth plan limit". Private networks and Enterprise are early access, contact sales. | Planned: 1 tunnel free, 5-tunnel trial, then pay as you go |
| Revenue model (inference) | Advertising to agents ("Pay to surface your tool"), app store, USDC wallet over x402, enterprise contracts | Hosted relay tiers |

## What Pilot turns on by default

Per the consent section that `install.sh` prints, each of these is on unless you opt out:

1. **Skill injection.** Pilot writes `~/.claude/skills/pilotctl/SKILL.md` and a "heartbeat ref" into `~/.claude/CLAUDE.md`. It does the same for OpenClaw, OpenHands, Hermes and Goose, and re-checks every 15 minutes. The [skillinject](https://github.com/pilot-protocol/skillinject) repo says the injected text is a "pilot first" directive.
2. **Broadcasts.** "Pilot Protocol can send messages to your agent through the daemon … to trigger coordinated actions across a network." In practice, the vendor can message your agent.
3. **Telemetry.** It records app store views and installs.
4. **Review prompts.**
5. **Auto-updates.** The updater replaces binaries in the background.

It also asks for an email at install for account recovery, and creates a placeholder identity if you skip that.

**Credibility gap (verified):** [issue #409](https://github.com/pilot-protocol/pilotprotocol/issues/409), "Security claims that overstate implemented behavior", lists several mismatches:
- `install.sh` claims a SLSA attestation and signed-manifest verification, but it only compares SHA-256 hashes.
- The prompt-injection blocking claim is overstated.
- The docs describe a random nonce prefix as replay protection.
- Uninstalling leaves the injected text in `~/.claude`.

The issue was closed in a "backlog reset". The maintainer noted the closure "does not mean… the reported defect is resolved", and the overstated text is still in `install.sh` today.

**The traction numbers:**
- The live counter (~219k "agents online", ~58k requests/sec) is real. Their own `llms.txt` defines it as "public-registry operational counters, not unique company, customer, or completed-task counts".
- 59k requests/sec spread over 218k nodes is about 0.27 requests/sec per node. That looks like heartbeats, not work being done (inference).
- The founder said on HN that clusters run 10–250 agents per IP.
- Community response is thin: two Show HN posts got 6 and 4 points, and the Product Hunt launch got 0 upvotes.

## Their website, read as marketing

**What it does well**
- Investor logos sit above the fold.
- A live throughput ticker and a live count of agents online.
- An install one-liner with a copy button.
- A Trust Center, a wire-format whitepaper, an IETF draft (Independent Submission) and an arXiv paper. These carry a lot of authority for a seed-stage company.
- **A JS-free `/plain/` mirror for agents,** plus a detailed `llms.txt` and a robots.txt that explicitly allows every AI crawler.
- 317 URLs in the sitemap: a learning center, a blog, `/for/*` use-case pages and an app directory. That's a deliberate SEO and GEO surface.
- **An install path that is only a prompt:** "Already have an agent? Just tell it: *Join Pilot Protocol (pilotprotocol.network) and get on the network.*"
- **A one-URL MCP endpoint** (`cloud.pilotprotocol.network/mcp`), so Claude, ChatGPT and Cursor users can use it without a shell.

**What's weak**
- **Four audiences on one page.** The homepage talks to agents ("Plug in your agent"), app publishers ("Publish your app", "Advertise to agents"), developers (P2P, MCP) and enterprise buyers ("Contact sales"). No single reader gets a clear first step.
- **Capability sprawl.** One sentence lists 12 things your agent can do: VMs, phone numbers, SQL, SMS, payments and more. The networking product is hard to find among the platform features.
- **Abstract hero.** "Network OS" and "the internet for agents" are category claims. Nothing tells a human what problem they get solved today.
- **Session replay** sits behind the cookie banner. That's an odd look for a privacy-first networking product.

## The exposure (ranked)

1. **Consent and control.** Default-on prompt injection into `CLAUDE.md`, a vendor broadcast channel to your agent, installs the owner never chose, and security claims overstated in their own issue tracker. Developers who care what their agent reads are the segment Pilot can't serve without killing its growth loop.

   **Move:** make "your agent, your rules" tunnel's explicit position, with checkable facts:
   - no daemon
   - nothing written to agent configs until you run `tunnel skills install`
   - no vendor messages
   - no telemetry
   - the relay sees only ciphertext
   - MIT licence, small enough to read in an afternoon

2. **The scope of the job.** Pilot asks you to join a network, take an address, trust handshakes and accept an app store. tunnel's whole story is three commands: `tunnel open`, `tunnel join 7-orange-fox-tide`, `tunnel send`.

   **Move:** lead with the job ("hand work from Claude Code on your laptop to Codex on your server") rather than a category. Pilot's hero leaves that space empty.

3. **Licence.** AGPL-3.0 puts off some companies that would embed or modify the code. tunnel is MIT.

   **Move:** say so wherever self-hosting comes up (README, pricing FAQ).

4. **Async delivery (unverified).** tunnel's relay holds messages for 7 days, so the two agents don't need to be online at the same time. Pilot is peer-to-peer and has an inbox, but I couldn't confirm it delivers to a peer that's offline.

   **Move:** don't claim this as a differentiator until someone tests `pilotctl send-message` against a stopped daemon.

## Don't do these

- **Compete on breadth.** App store, wallet, live data from 430+ specialist agents, phone numbers, enterprise RBAC and SIEM export: they have $4.5M and a team, and tunnel shouldn't try to match it.
- **Compete on price.** Their public network is free and unmetered. Charging for the second tunnel against a free, unlimited, VC-funded alternative is a weak position. Paid tiers need to sell something they don't give away. Candidates: a managed private relay for a team, longer retention or bigger files, or support/SLA. Until then, keep the free tier generous. This is the uncomfortable finding of this teardown, and it's worth a rethink of the [pricing section](../../site/index.html) before billing gets built.
- **Compete on numbers or raw networking.** Don't post agent counts. Don't make P2P latency or NAT traversal claims either; they genuinely do UDP hole-punching and tunnel doesn't.
- **Write attack copy that names them.** Contrast through facts about tunnel ("nothing runs in the background") and let readers compare. If a comparison page ever names them, cite only the public record: their install output, issue #409 and the HN quote.

## Worth copying

1. **A prompt-only install line** on the landing page and in the README. For example: "Already have Claude Code or Codex open? Tell it: *Install tunnel from tunnel.dilyor.dev and open a tunnel to my server.*" It's cheap and it fits the product. Make sure `llms.txt` contains everything an agent needs to follow that instruction.
2. **A `/plain/`-style page,** or just keep `llms.txt` complete. tunnel already has `llms.txt`. A one-line metrics or claims-honesty statement like theirs is a good habit, but tunnel has no metrics to publish yet.
3. **Use-case pages** on the `/for/*` pattern: "Claude Code ↔ Codex", "laptop agent ↔ server agent", "hand off a build artefact between machines". Each page targets one search query. Three pages would multiply tunnel's indexable surface.
4. **More skill targets,** installed only on request. Pilot covers Claude Code, OpenClaw, OpenHands, Hermes and Goose. `tunnel skills install` covers Claude Code and Codex. Adding Cursor, Goose and OpenHands paths widens reach without the consent problem.
5. **An MCP mode** (`tunnel mcp`). This would let Claude Desktop, Cursor and ChatGPT users use tunnel without a shell. It's a medium-sized build and the biggest reach gain on this list.
6. **Trust documents.** Their Trust Center and whitepaper read as serious. tunnel's equivalent is one honest page: the threat model, what the relay sees, what it can't, and the crypto in plain words. Credibility costs little when every claim is true.

## What I couldn't determine

- Whether Pilot delivers messages to an offline peer.
- Real active usage. The counters measure heartbeating daemons; there's no data on messages between distinct owners.
- Ad spend. I didn't pull ad libraries, but there's no sign of paid acquisition; growth looks like install-time skill injection (inference).
- App store take rate and enterprise prices, which aren't published anywhere.
- Hiring plans (job posts not checked).
- Whether the overstated security claims in issue #409 have been fixed in the code. They are still in the `install.sh` text as of today.
