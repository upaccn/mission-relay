# Plugin API

This is an **early protocol draft**. `apiVersion: 1` is the first internal built-in adapter contract, not a promise of stable third-party ABI in v0.1.

The core exposes namespaced, semver-manifested plugins with declared capabilities. `PluginRegistry` currently accepts trusted, explicitly imported implementations only; **it does not install or execute arbitrary third-party plugin packages**. This is intentional while the security and isolation model is being tested.

The initial built-ins are `executor.codex` (`execute-turn`, `resume-thread`, `verify-read-only`) and experimental `channel.telegram` (`receive-command`, `notify`). The Codex implementation delegates to OpenAI's official SDK and owns no mission database. The Telegram channel uses the native task store's durable command inbox and never owns the Mission itself.

The `link-chat` / `handoff` metadata itself is not an executor. The optional Playwriter browser adapter can inspect the linked **rendered page** and use its composer with bounded prompts. It does not use a ChatGPT private API; a reply observed in a browser is recorded as a pause/checkpoint, never as independently verified `COMPLETED`.

The eventual contract separates `Executor`, `MissionProvider`, `Channel`, `ComputerUse`, and `Verifier` adapters. It will require authenticated operator commands, state-version preconditions, request-idempotency keys and bounded privileges. No external channel or remote browser is enabled by default.
