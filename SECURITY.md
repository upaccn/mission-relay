# Security policy

Mission Relay is early-stage software. Do **not** use it for unattended production deployments, money transfers, credential management, or destructive workflows.

## Reporting

Please use GitHub's private security-advisory reporting mechanism for this repository when enabled, rather than publishing working exploits, account secrets or private logs in an issue. If private reporting is unavailable, open a non-sensitive issue requesting a secure contact path.

## Trust boundaries

- This project never requests ChatGPT cookies or passwords. Codex authentication stays in the official Codex installation.
- Model output and external pages are untrusted. A model's assertion of success is not sufficient evidence of completion.
- SQLite state is local and may include mission prompts and workspace paths; protect the user-data directory.
- A failed or interrupted write-capable turn is ambiguous until reconciled by the operator. No blind retries.
- `workspace-write` means the agent may modify the selected workspace. Prefer dedicated Git worktrees and inspect changes before merging.
- The Codex filesystem sandbox alone does **not** guarantee that every preconfigured MCP server or external tool is read-only. Operators must review their executor configuration and disable high-risk tools for unattended missions. Future explicit tool-capability policy is tracked in issue #4.
- Telegram and Playwriter are high-trust optional adapters, not read-only sandboxes. They must be explicitly enabled, narrowly authorized and revocable; every browser-linked Mission must be pinned to the operator-approved Chrome instance before browser access.
- The Telegram bot token and user allowlist remain in the local process environment. They are deliberately **not forwarded** to Codex or deterministic check subprocesses; those processes receive a narrow environment allowlist. Test scripts do not inherit arbitrary host credentials by default.
- Telegram requires a current expected mission revision for every state-changing command except emergency `/pause`, and disallows remote execution, resume and instruction of `workspace-write` tasks. These gates are additional checks, not a substitute for the operator reviewing the configured Codex sandbox and external tools. A poller started from an older checkout keeps its old behavior until restarted.
- Native missions default to a separately initialized Codex home. **Do not reuse your general-purpose `~/.codex`** for unattended execution: it may contain powerful MCP tools, custom proxy routes and tool credentials. Authentication is performed through official Codex login under the isolated home, without copying cookies or stored tokens.
- Playwriter browser control is **opt-in** for the exact registered ChatGPT conversation and a pinned browser instance. No cookie reading, profile copying, internal ChatGPT APIs, arbitrary page scripting supplied over Telegram or other-tab navigation is implemented. The optional dependency starts a loopback relay; enabling the extension grants substantial browser authority, so review permissions and disable the extension when the pilot is over. Operator notes are consumed once after the observed reply, preserving concurrent changes; ambiguous sends preserve notes and never blindly retry.
- Before a browser Send click, Mission Relay durably reserves the request key and prompt SHA-256 in SQLite. A lost connection or process crash produces an ambiguous state that **must be manually reconciled**; the same request key is never replayed. Automatic multi-turn driving is capped at eight turns from the CLI and three from Telegram per command, and halts without an explicit `[MISSION_RELAY:NEXT]` marker.
- Playwriter can capture visible content from an authenticated ChatGPT page. This data remains sensitive, including URLs and excerpts in local SQLite / controlled Telegram notifications. Never publish these records or diagnostic logs.

No security guarantee is made that a model-based verifier detects all mistakes. Use deterministic project checks and human review for consequential work.

## Public Git history and stable-baseline hygiene

`npm run privacy-check` runs on each supported CI platform and checks the **current tracked tree** for non-synthetic ChatGPT conversation URLs, Chrome installation identifiers and common credential formats without printing matching values. It is a preventive check, not proof that secrets are absent from historical commits or external logs.

At a validated stable alpha milestone, the repository maintainer may replace historical public Git commits with a single reviewed baseline **only after** inspecting tags, branches, pull requests, forks, public history contents, release references and running clean cross-platform CI. A forced Git ref update must use an explicit expected old SHA (`--force-with-lease`), and every owned checkout must be synchronized to the exact same new baseline, not silently retain conflicting roots. Do not include prior private user or browser identifiers in the baseline tree, release notes or logs.

History compaction removes public branch reachability; it does **not** guarantee erasure of old commit SHA URLs, GitHub caches, Actions logs, third-party clones, mirrors, or locally retained reflogs. Consult [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) and request GitHub Support follow-up when appropriate. Rotate any exposed credential even if Git refs are rewritten; no rewrite substitutes for rotation.
