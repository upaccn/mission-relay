# Plugin API

This is an **early protocol draft**. `apiVersion: 1` is the current internal adapter contract, not a promise of a stable third-party ABI or an isolated plugin sandbox.

The core exposes namespaced, semver-manifested plugins with declared capabilities. `PluginRegistry` validates explicitly registered implementations. **It does not fetch or automatically execute arbitrary third-party packages**. This is intentional while the trust and isolation model is being tested.

The default build does not import a coding-agent SDK. Native executors are optional locally registered modules, and ChatGPT browser + PI + Telegram do not need one. The Telegram channel uses the native task store's durable command inbox and never owns the Mission itself.

## Optional native executor contract

An executor module exports `manifest` (namespaced `id`, semver `version`, `apiVersion: 1`, `kind: 'executor'`, `execute-turn` and `verify-read-only` capabilities), `createExecutor()` returning an `AgentAdapter` with `execute()`/`verify()`, and optional `preflight()`. `AgentAdapter` is the stable existing internal interface; there is no native SDK or vendor-specific model in Core. Module loading is **trusted in-process code**, not a sandbox.

Install a trusted plugin and its dependencies separately, then register its **absolute** local `.mjs`/`.js` entry file:

```
mission-relay plugin-register --path /absolute/path/to/executor/index.mjs
mission-relay plugin-list
mission-relay plugin-default --id executor.example   # optional only if desired
mission-relay plugin-remove --id executor.example
```

Many executor IDs can be registered concurrently. The first installed is initially the default; adding another never changes it automatically. No selection is requested on first run of ChatGPT, which needs no native executor. A native Mission persistently binds to its chosen executor ID on first dispatch; changing the default, adding or removing plugins cannot silently migrate an in-progress Mission to a different provider. The single executor selection is not an LLM inference or proof that two runtimes have identical permissions. Additional per-mission selection and trust-scoped package installation are future APIs; no package marketplace or hot reload is claimed.

`examples/executors/codex` contains an **optional** Codex adapter for operators who choose it. Claude Code, Pi with a selected model provider, DeepSeek-backed runtimes, and other agents can implement the same contract without changes to Core. A model provider and an agent runtime are different layers: one runtime plugin may support multiple model providers. No unsupported vendor SDK is bundled or implied.

The `link-chat` / `handoff` metadata itself is not an executor. The optional Playwriter browser adapter can inspect the linked **rendered page** and use its composer with bounded prompts. It does not use a ChatGPT private API; a reply observed in a browser is recorded as a pause/checkpoint, never as independently verified `COMPLETED`.

The eventual contract separates `Executor`, `MissionProvider`, `Channel`, `ComputerUse`, and `Verifier` adapters. It will require authenticated operator commands, state-version preconditions, request-idempotency keys and bounded privileges. No external channel or remote browser is enabled by default.
