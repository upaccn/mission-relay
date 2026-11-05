# Optional Codex executor

This package is **not** a dependency of Mission Relay. It is one optional implementation of the native `AgentAdapter` contract. Install it only if you want Codex as a native coding agent; browser-first ChatGPT and PI need no native executor at all.

From the Mission Relay repository root:

```sh
npm ci --prefix examples/executors/codex
npm run init --prefix examples/executors/codex
```

`init` prints an isolated `CODEX_HOME` path. Set `CODEX_HOME` to that path in your private terminal, authorize through the official `codex login` process, and verify `codex login status`; never copy a daily-use account profile or credentials into the project. The optional module defaults to the same isolated path, or honors an explicitly set `MISSION_RELAY_CODEX_HOME`.

```sh
node dist/cli.js plugin-register --path /absolute/path/to/mission-relay/examples/executors/codex/index.mjs
node dist/cli.js plugin-list
node dist/cli.js doctor
```

Registration imports trusted code. `doctor` is only a preflight, not an authenticated task execution or permission proof. An isolated Codex profile declaring MCP servers with unverified permissions is rejected by the plugin's `preflight`. The plugin supplies its own SDK dependency, proxy handling and optional Windows sandbox selection. Install additional vendor-specific executor plugins independently; Mission Relay never asks for an agent during browser-first onboarding.
