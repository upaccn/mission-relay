# Security policy

Mission Relay is early-stage software. Do **not** use it for unattended production deployments, money transfers, credential management, or destructive workflows.

## Reporting

Please use GitHub's private security-advisory reporting mechanism for this repository when enabled, rather than publishing working exploits, account secrets or private logs in an issue. If private reporting is unavailable, open a non-sensitive issue requesting a secure contact path.

## Trust boundaries

- This project never requests ChatGPT cookies or passwords. ChatGPT is the only executor; there is no native agent subprocess.
- Model output and external pages are untrusted. A model's assertion of success is not sufficient evidence of completion.
- SQLite state is local and may include mission prompts and workspace paths; protect the user-data directory.
- A failed or interrupted turn is ambiguous until settled with `recover` (`--accept-reply` or `--abandon`). No blind retries.
- `workspace-write` means ChatGPT is told it may modify the selected approved repository. This is prompt-level authorization, not an OS sandbox: review the tools connected to the ChatGPT account and disable high-risk ones for unattended Goals.
- Telegram and Playwriter are high-trust optional adapters, not read-only sandboxes. They must be explicitly enabled, narrowly authorized and revocable; every browser-linked Mission must be pinned to the operator-approved Chrome instance before browser access.
- The Telegram bot token and user allowlist remain in the local process environment. They are deliberately **not forwarded** to child processes (PI SSH, Git/CI readers); those receive a narrow environment allowlist.
- Telegram accepts only the allowlisted owner. Writable Goals require a locally approved repository; Telegram cannot grant one. Ambiguous Sends are never reconciled from Telegram. A poller started from an older checkout keeps its old behavior until restarted.
- Playwriter browser control is **opt-in** for the exact registered ChatGPT conversation and a pinned browser instance. No cookie reading, profile copying, internal ChatGPT APIs, arbitrary page scripting supplied over Telegram or other-tab navigation is implemented. The optional dependency starts a loopback relay; enabling the extension grants substantial browser authority, so review permissions and disable the extension when the pilot is over. Owner notes go to PI, never directly into ChatGPT; ambiguous sends never blindly retry.
- Before a browser Send click, Mission Relay durably reserves the request key and prompt SHA-256 in SQLite. A lost connection or process crash produces an ambiguous state that **must be settled with `recover`**; the same request key is never replayed. Each ChatGPT conversation carries at most eight Relay Sends, and every next Send needs a PI decision on a fully observed answer.
- Playwriter can capture visible content from an authenticated ChatGPT page. This data remains sensitive, including URLs and excerpts in local SQLite / controlled Telegram notifications. Never publish these records or diagnostic logs.

No security guarantee is made that PI review detects all mistakes. Use project CI and human review for consequential work.

## Public Git history and stable-baseline hygiene

`npm run privacy-check` runs on each supported CI platform and checks the **current tracked tree** for non-synthetic ChatGPT conversation URLs, Chrome installation identifiers and common credential formats without printing matching values. It is a preventive check, not proof that secrets are absent from historical commits or external logs.

The public v1.0 source history starts from a reviewed root commit. Any future history rewrite requires checking **all** branches, tags, releases, pull requests, forks, Actions artifacts and running checkouts, followed by qualified CI and gated deployment. Use an explicit expected old SHA (`--force-with-lease`) for an authorized ref rewrite. Never include private operator identifiers or paths in public source, release notes or logs.

History compaction removes public branch reachability; it does **not** guarantee erasure of old commit SHA URLs, GitHub caches, Actions logs, third-party clones, mirrors, or locally retained reflogs. Consult [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) and request GitHub Support follow-up when appropriate. Rotate any exposed credential even if Git refs are rewritten; no rewrite substitutes for rotation.
