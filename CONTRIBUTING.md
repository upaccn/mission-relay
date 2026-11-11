# Contributing

Mission Relay welcomes small, testable improvements to reliable long-running AI mission control.

1. Read `AGENTS.md`, `docs/architecture.md`, and `SECURITY.md`.
2. Open a focused issue before major protocol, schema or plugin API changes.
3. Run `npm ci`, `npm run check`, `npm test`, and `npm run build`.
4. Add failure-path tests and preserve backward compatibility when changing persisted state.
5. Do not include private workspaces, credentials, recorded ChatGPT conversations, cookies, or real mission databases in PRs.

Development happens in a public repository. Stable protocol versions and security controls take precedence over feature count.
