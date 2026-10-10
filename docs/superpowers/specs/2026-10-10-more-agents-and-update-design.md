# More agents, and `tunnel update`: design

Date: 2026-10-10. Status: approved in chat, awaiting spec review.
Branch: `feat/more-agents`, on top of `feat/accounts-billing-stats`. That branch is live on tunnel.dilyor.dev but not merged; building on `main` would conflict in the README and the site.

## Goal

- Every major AI coding agent that can run shell commands learns tunnel from `tunnel skills install` and works with it without surprises. That means OpenCode, Cursor, Gemini CLI, Copilot, Windsurf/Devin, Cline, Amp, Goose, Kiro and the rest, not only Claude Code and Codex.
- People can update with one command, `tunnel update`, and hear about new versions without having to go looking.
- The README, landing page, `llms.txt` and installers stop saying tunnel is for "Claude Code and Codex".

**Out of scope:**
- An MCP server (the owner chose shell agents only).
- `tunnel skills uninstall`.
- Editing shared instruction files (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`, `global_rules.md`).
- Publishing to the npm registry.

## Decisions (from the 2026-10-10 discussion)

| Question | Decision |
|---|---|
| Which agents | All shell-capable coding agents, broad coverage. The owner's own picks are OpenCode and the long tail. |
| MCP | No. Shell agents only. |
| Where `skills install` writes | Agents found on the machine, plus the shared `~/.agents/skills` (owner's pick). |
| Update | A `tunnel update` command, plus at most one hint a day when a newer version exists (owner's pick). |

## What the research found

The research was done on 2026-10-10 against official docs and source. The notes are in the session scratchpad and are not committed.

- **`~/.agents/skills` is the cross-agent skills folder.** It is read by about 21 agents: Codex, Cursor, Gemini CLI, OpenCode, Copilot (VS Code and CLI), Windsurf/Devin, Cline, Amp, Goose, Zed, Auggie, Factory, Junie, Qwen Code, Crush, Kilo, Mistral Vibe, Pi, OpenClaw, Warp and Roo (archived).
- **Claude Code does not read it.** It reads `~/.claude/skills`, and so do about 10 other agents. tunnel already writes both folders, so the gap is mostly in the words, plus a few agents with their own folders.
- **Agents with their own folder only:**

  | Agent | Folder |
  |---|---|
  | Kiro | `~/.kiro/skills` |
  | Antigravity CLI | `~/.gemini/antigravity-cli/skills` |
  | Continue | `~/.continue/skills` |
  | Hermes | `~/.hermes/skills` |
  | Letta | `~/.letta/skills` |
  | Copilot CLI with `COPILOT_HOME` set | `$COPILOT_HOME/skills` |

  Aider has no skills support.
- **`tunnel wait`'s 300 s default collides with most agents' command limits.** OpenCode and Claude Code stop a command at 2 minutes by default. Gemini CLI kills a command that has been silent for 300 s, and Goose's limit is exactly 300 s. Crush moves a command to the background after 60 s, and Codex hands control back after 30 s and polls.
- **Codex's default sandbox blocks network.** It then sets `CODEX_SANDBOX_NETWORK_DISABLED=1`, and every tunnel call fails with "unreachable".
- **Few agents can watch a command's output line by line.** Claude Code (Monitor) and Qwen Code (`monitor`) can wake on each output line. Others wake only when a command exits, or not at all.

## 1. `tunnel skills install` finds the agents

The skill file stays one file: `cli/skills/tunnel/SKILL.md`. It is installed as `<folder>/tunnel/SKILL.md` in every target folder. Writes are copies, not symlinks, because symlinks need admin rights on Windows.

### Targets

Every agent tunnel knows has:
- a name for `--agent`;
- a label for output;
- one or more marker paths, any of which counts as "installed";
- the folder it reads tunnel from.

`HOME` is `TUNNEL_SKILLS_HOME` or the home directory, as today. `CONFIG` is `$XDG_CONFIG_HOME`, or else `HOME/.config`.

| `--agent` | Label | Marker (any) | Skill folder |
|---|---|---|---|
| `claude` | Claude Code | `HOME/.claude` | `HOME/.claude/skills` |
| `codex` | Codex | `HOME/.codex` | shared |
| `cursor` | Cursor | `HOME/.cursor` | shared |
| `gemini` | Gemini CLI | `HOME/.gemini` | shared |
| `opencode` | OpenCode | `CONFIG/opencode` | shared |
| `copilot` | GitHub Copilot | `HOME/.copilot`, or `$COPILOT_HOME` when set | shared; plus `$COPILOT_HOME/skills` when `COPILOT_HOME` is set, because Copilot CLI then stops reading the shared folder |
| `windsurf` | Windsurf | `HOME/.codeium/windsurf`, `CONFIG/devin` | shared |
| `cline` | Cline | `HOME/.cline` | shared |
| `amp` | Amp | `CONFIG/amp` | shared |
| `goose` | Goose | `CONFIG/goose` | shared |
| `zed` | Zed | `CONFIG/zed` | shared |
| `auggie` | Auggie | `HOME/.augment` | shared |
| `factory` | Factory | `HOME/.factory` | shared |
| `junie` | Junie | `HOME/.junie` | shared |
| `qwen` | Qwen Code | `HOME/.qwen` | shared |
| `crush` | Crush | `CONFIG/crush` | shared |
| `kilo` | Kilo Code | `HOME/.kilo` | shared |
| `pi` | Pi | `HOME/.pi` | shared |
| `vibe` | Mistral Vibe | `HOME/.vibe` | shared |
| `openclaw` | OpenClaw | `HOME/.openclaw` | shared |
| `kiro` | Kiro | `HOME/.kiro` | `HOME/.kiro/skills` |
| `antigravity` | Antigravity CLI | `HOME/.gemini/antigravity-cli` | `HOME/.gemini/antigravity-cli/skills` |
| `continue` | Continue | `HOME/.continue` | `HOME/.continue/skills` |
| `hermes` | Hermes | `HOME/.hermes` | `HOME/.hermes/skills` |
| `letta` | Letta | `HOME/.letta` | `HOME/.letta/skills` |

"Shared" means `HOME/.agents/skills`. The shared folder is written on every default run, so for shared-folder agents the marker only decides whether the output names them. A missed marker (Zed and Goose keep their config under `%APPDATA%` on Windows) costs a label, not an install.

This table lives in one module, `cli/src/agents.ts`, as data. Adding an agent later means adding one row.

### Behaviour

- **`tunnel skills install`** (no flags):
  - always writes the shared folder;
  - writes each other folder whose agent has a marker present;
  - skips everything else.
- **`--agent <name>`**, repeatable or comma-separated:
  - writes exactly the folders those agents read (`--agent claude` writes only `HOME/.claude/skills`), whether or not a marker exists;
  - an unknown name is a usage error that lists the known names.
- **`--all`:** writes the shared folder and every agent-specific folder. The `COPILOT_HOME` folder is written only when `COPILOT_HOME` is set.
- **`--claude` and `--codex`** keep working as aliases for `--agent claude` and `--agent codex`.
- **`--refresh`** (used by `tunnel update`): rewrites only `tunnel/SKILL.md` files that already exist in any known folder and start with `name: tunnel` frontmatter. It creates nothing, and prints `No installed tunnel skills to refresh.` when it finds none. Its output and `--json` shape match a normal install.
- **Output:** one line per folder written, naming the detected agents that read it. For example:

  ```
  Installed the tunnel skill:
    ~/.agents/skills/tunnel   Codex, Cursor, OpenCode, and other agents that read ~/.agents/skills
    ~/.claude/skills/tunnel   Claude Code
    ~/.kiro/skills/tunnel     Kiro
  ```

  - With no agent detected, the shared line reads `agents that read ~/.agents/skills`.
  - Paths under the home directory print as `~/…`.
  - `--json` prints `{"installed":[{"dir":"…","agents":["Codex",…]}]}`.
- **Rules-only agents:** nothing is written for agents that only have shared instruction files. The README's "Other agents" section covers them, starting with Aider: `aider --read ~/.agents/skills/tunnel/SKILL.md`.

## 2. Working inside other agents

### `tunnel wait` default

The default `--timeout` drops from 300 to **90** seconds:
- 90 s fits under OpenCode's and Claude Code's 2-minute default and Gemini CLI's 300 s silence limit, with room to spare;
- it costs one extra call per 90 s for agents that can't wait longer.

The default becomes a named, exported constant `WAIT_DEFAULT_S = 90` in `commands.ts`. The timeout message stays: `No new messages after 90s. Run \`tunnel wait\` again to keep waiting.` The help line becomes `tunnel wait [--timeout 90]`. An explicit `--timeout` takes any positive number of seconds, as today.

### Agent names

`agentKind` gains these env checks, in order. The first match names the agent.

| Env | Name |
|---|---|
| `CLAUDECODE` | `claude` |
| any `CODEX_*` | `codex` |
| `KILO_PID` | `kilo` |
| `OPENCODE` | `opencode` |
| `GEMINI_CLI` | `gemini` |
| `CURSOR_AGENT` | `cursor` |
| `COPILOT_CLI` | `copilot` |
| `GOOSE_TERMINAL` | `goose` |
| `CRUSH` | `crush` |
| `QWEN_CODE` | `qwen` |
| `PI_CODING_AGENT` | `pi` |

- **`kilo` before `opencode`:** Kilo also sets `OPENCODE=1`.
- **`AI_AGENT`:** after the table, `AI_AGENT` is lowercased and, when it matches `^[a-z][a-z0-9-]{0,31}$`, used as the name.
- **Fallback:** the username, then `agent`, as today.
- **Precedence:** `--as` and `TUNNEL_AS` still win.
- **Safety:** these variables only pick a default name and are never used for security.

### Codex sandbox hint

When a relay call fails because the relay can't be reached (not on a timeout) and `CODEX_SANDBOX_NETWORK_DISABLED=1`, the error gets a second line:

```
Codex's sandbox blocks network access. Add network_access = true under [sandbox_workspace_write] in ~/.codex/config.toml, or approve running tunnel outside the sandbox.
```

### Skill text (`cli/skills/tunnel/SKILL.md`)

- **Waiting, rewritten to be harness-neutral:**
  - If the harness can run a command in the background and wake you on each output line (for example Claude Code's Monitor or Qwen Code's monitor), run `tunnel listen` that way.
  - Otherwise, when blocked on a reply, run `tunnel wait`. It returns within 90 s; run it again until a reply arrives or you decide to tell the user you are still waiting.
  - If your harness lets you set a command timeout, keep it above the `--timeout` you pass.
- **Names:** say `--as <your agent name>` (claude, codex, cursor, gemini, opencode, …) and that tunnel guesses it when omitted.
- **Codex:** one line saying that if every call says the relay is unreachable inside Codex, the sandbox is blocking network, and to tell the user the fix the error prints.
- **Updates:** if a command prints a line saying a newer tunnel is out, mention it to the user. Never run `tunnel update` unless the user asks.
- **Frontmatter:** `name: tunnel` stays first, which the tests depend on. The description stays agent-neutral; it already is.

## 3. `tunnel update` and the daily hint

### Versions

- The package goes to **0.2.0**, in `cli/package.json`, `cli/package-lock.json` and `cli/src/version.ts`.
- From now on every deploy that changes the CLI bumps the version. `deploy.sh` already names the tarball by version.

### Latest version

- **Relay header:** the relay adds `x-tunnel-version: <VERSION>` to every response.
- **`tunnel update`:** asks `https://tunnel.dilyor.dev/v1/health` (which already returns `version`), and compares numerically by major, minor and patch.

### How tunnel was installed

The installed file `dist/bin.js` resolves to one of three layouts.

- **Script install:** the path is `<dir>/lib/tunnel-ai/dist/bin.js`, and `<dir>/bin/tunnel` or `<dir>/bin/tunnel.cmd` exists.
  - On macOS and Linux: download `https://tunnel.dilyor.dev/install.sh` to a temp file and run `sh <file>`.
  - On Windows: download `install.ps1` and run `powershell -NoProfile -ExecutionPolicy Bypass -File <file>`.
  - Both run with `TUNNEL_INSTALL=<dir>` and `TUNNEL_NO_MODIFY_PATH=1`. The installer's output passes through.
  - Then go on as in "After either install" below.
- **npm global install:** the path contains `node_modules/tunnel-ai/`.
  - Run `npm i -g https://tunnel.dilyor.dev/tunnel-ai.tgz`, through a shell on Windows for `npm.cmd`.
  - Then go on as in "After either install" below.
- **Anything else** (a git checkout run through tsx, or an unknown layout): print the three install commands from the README and exit 1. Nothing is changed.
- **After either install:** both replace the files in place, so the same `dist/bin.js` now holds the new version.
  - Run `<node> <dist/bin.js> --version`, with `<node>` being `process.execPath`. If it doesn't report a newer version, the update failed. This also catches `install.ps1`, which reports errors but always exits 0.
  - Run `<node> <dist/bin.js> skills install --refresh`, so the new version's skill text is used. Running node directly avoids spawning a `.cmd` on Windows, and avoids picking up some other `tunnel` on `PATH`.
- **Release base:** `TUNNEL_DOWNLOAD`, the variable the installers already read, overrides `https://tunnel.dilyor.dev` for the version check, the installer and npm downloads, and the daily hint. It is passed on to the installer. Tests and the manual check use it.

### Messages

| Situation | Output | Exit |
|---|---|---|
| Already current | `Already up to date (0.2.0).` | 0 |
| Updated | `Updated tunnel 0.2.0 → 0.3.0.` followed by the refresh output | 0 |
| Health check fails | `Couldn't reach tunnel.dilyor.dev to check for updates.` plus the unreachable/Codex hint rules above | 1 |
| Installer or npm fails | `The update failed (<command> exited with <code>). Your current tunnel 0.2.0 still works.` | 1 |
| Installer exits 0 but the version didn't change | `The update failed (<command> finished, but tunnel still reports 0.2.0). Your current tunnel 0.2.0 still works.` | 1 |
| Update failed and tunnel no longer starts | `The update failed (<command> exited with <code>), and tunnel no longer starts. Reinstall it:` followed by the install commands | 1 |
| Health answer has no x.y.z version | `<host> didn't say which version is latest. Try again later.` | 1 |

Once the installer or npm has run, "still works" is printed only after `<node> <dist/bin.js> --version` confirms the old version still runs.

The installers replace files in place.

**Windows risk:** `cmd.exe` reads a running `.cmd` file as it goes, so rewriting `bin\tunnel.cmd` while it runs can make cmd execute garbage after node exits. The installer must leave `tunnel.cmd` byte-identical when nothing changed. The shim also starts its node line with `goto #_undefined_# 2>NUL ||`, the trick npm's cmd-shim uses: cmd stops reading the file once that line runs, so a rewrite can't be misread. The npm shim is regenerated identically. The plan includes a real Windows test of `tunnel update` from a script install.

### The daily hint

The hint is printed after a command finishes, whether it succeeded or failed, when all of these hold:
- `TUNNEL_NO_UPDATE_CHECK` is not `1`;
- during this run, a response from the hosted relay (`https://tunnel.dilyor.dev`, or `TUNNEL_DOWNLOAD`) carried `x-tunnel-version`;
- that version is newer than `VERSION`;
- `config.json`'s `updateHintAt` is missing or more than 24 hours old.

It prints one line to stderr and records `updateHintAt`:

```
tunnel 0.3.0 is out (you have 0.2.0). Run `tunnel update` to get it.
```

No extra request is made for the hint. Self-hosted relays never trigger it, because their version says nothing about the hosted release. `tunnel update` and `tunnel relay` never print it.

## 4. Words

- **README:**
  - The intro names "Claude Code, Codex, Cursor, Gemini CLI, OpenCode, or any agent that runs shell commands".
  - "Teach your agents" describes the detection and the shared folder.
  - A new "Other agents" subsection covers `--agent`, `--all`, the Aider line, and "any agent that can run shell commands can use tunnel; point it at `tunnel help`".
  - The install section says "Run `tunnel update` to update".
  - Copy the README to `cli/README.md`, as today.
- **Landing page (`site/index.html`):**
  - The title, description and Open Graph text name the broader set.
  - The "Your agent already knows how" section shows the new install output.
  - The hero scenario (Claude Code on the laptop, Codex on the server) stays, because it is a concrete example.
- **`llms.txt`:** the agent list and the "For agents asked to install tunnel" steps.
- **Installers (`install.sh`, `install.ps1`):** the closing hint becomes `tunnel skills install    teach your coding agents to use it`.
- **`tunnel help`:**
  - `tunnel skills install [--agent name] [--all]   Teach your coding agents to use tunnel`
  - `tunnel update   Update tunnel to the latest version`
- **`cli/package.json`:** the description and keywords add cursor, gemini, opencode and agents.

## Testing

Tests are in-process, as today, with `TUNNEL_SKILLS_HOME` pointing at a temp home.

- **Skills install:**
  - The default with an empty home writes only the shared folder.
  - Markers for Claude Code, Kiro and OpenCode write the shared, Claude and Kiro folders, and the output names OpenCode on the shared line.
  - `--agent claude` writes only the Claude folder.
  - `--agent nope` is a usage error.
  - `--all` writes every folder.
  - `--refresh` rewrites only existing tunnel skills and leaves an unrelated `SKILL.md` alone.
  - `--json` gives the documented shape.
- **Agent names:** each env row gives its name. Kilo beats OpenCode. `AI_AGENT` is validated. `--as` wins.
- **`tunnel wait`:** `WAIT_DEFAULT_S` is 90 and the help text says `[--timeout 90]`. The existing timeout test keeps passing an explicit short `--timeout`, so no test waits 90 s.
- **Codex hint:** an unreachable relay plus `CODEX_SANDBOX_NETWORK_DISABLED=1` gives the two-line error. A timeout does not get the hint.
- **Daily hint:**
  - It prints once when the fake hosted relay sends a newer version, and is silent within 24 hours.
  - It is silent for an older or equal version, for a non-hosted base, with `TUNNEL_NO_UPDATE_CHECK=1`, and for `tunnel update` itself.
  - The relay sends `x-tunnel-version` on every response, including errors.
- **`tunnel update`:**
  - The install-layout detection is a pure function, tested for the script layout (POSIX and Windows paths), npm and unknown.
  - The command runs its child processes through an injectable runner, so tests assert the exact commands, env and refresh step, and the up-to-date, failure and unknown-layout paths, without running real installers.
- **Manual:** run `tunnel update` from a real script install on Windows and on Linux (the server), from 0.2.0 to a locally served 0.2.1 build, or against the live site after deploy.

## Rollout

1. Implement on `feat/more-agents`, then review it.
2. Deploy relay and site with version 0.2.0. Deploying needs the owner's yes.
3. Existing 0.1.0 installs have no `tunnel update`. They update once by re-running the installer, and the README says so. From 0.2.0 on, the hint and `tunnel update` take over.
