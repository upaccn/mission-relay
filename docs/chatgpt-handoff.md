# Existing ChatGPT conversation handoff (human-in-the-loop)

## What this solves

The target user workflow is a **previously established ChatGPT conversation in Chrome**, not a new Codex CLI thread. The operator wants continuity, result review, bounded next steps and a clean context handoff when the conversation becomes long.

The `link-chat` / `handoff` path provides a durable link and audited **manual** handoff. Separately, the optional Playwriter adapter can operate this exact ChatGPT tab through the visible composer, record a browser response, and run bounded continuation turns. Browser observation is not independent proof of task completion; sending a prompt manually or by Playwriter never directly marks a Mission `COMPLETED`.

## How to use

1. **Preferred:** Create a ChatGPT-linked Mission in one step, without a Codex workspace:

   ```sh
   node dist/cli.js chat-create --goal "Continue the research" --accept "Verify conclusions with sources" --url https://chatgpt.com/c/<conversation-id>
   ```

   Alternatively select an existing unfinished Mission in `READY`, `PAUSED` or `BLOCKED`. Completed, cancelled, running and ambiguous missions cannot be repurposed.
2. Copy an existing ChatGPT conversation's address manually from Chrome. Only direct `https://chatgpt.com/c/<conversation-id>` (or supported `/g/<gpt-id>/c/<conversation-id>`) URLs are accepted. No query strings, credentials or fragments.
3. For an **existing unlinked Mission only**, read its revision with `node dist/cli.js show <mission-id>`.
4. Link that existing Mission with `node dist/cli.js link-chat <mission-id> --url <url> --revision <current-version>`. Skip these two steps when using `chat-create`.
5. Run `node dist/cli.js handoff <mission-id>`, or issue `/handoff <mission-id>` to the private Telegram bot **after a controlled restart of the foreground channel with the new code**.
6. Open the link and **manually** send the suggested next-step instructions in the already signed-in ChatGPT conversation. Review the actual result there. If appropriate, use ChatGPT's own scheduled tasks **inside that chat** for future follow-up.

Linking is idempotent for the same URL, revision-checked and audit logged (`chatgpt.handoff_linked`). The `chat-create` command creates a Mission with **no local Codex workspace**; the `read-only` flag does not change permissions inside ChatGPT. A linked Mission rejects native Codex `run`; Telegram `/continue` instead routes to the Playwriter browser adapter if the extension has been enabled. See [Playwriter operations](playwriter-evaluation.md).

If you need to move to a new ChatGPT conversation due to context length, ask the existing ChatGPT conversation for a handoff including: objective, confirmed facts, evidence links, attempted and failed approaches, decisions, current blockers, remaining steps and acceptance criteria. Open a new conversation yourself; link its URL again with the then-current Mission revision. ChatGPT-only history and tool permissions are not assumed transferable by Mission Relay.

## Optional browser continuation and alternative native scheduling

When Chrome Playwriter has been manually enabled on the exact target tab, Mission Relay can perform a bounded sequence through the ordinary ChatGPT composer. Separately, native ChatGPT scheduling/Work can provide in-product follow-ups. These two mechanisms are not interchangeable, and Mission Relay cannot inspect native Work's private internal state.

Suggested instruction **inside the existing ChatGPT Work conversation**:

> Continue this project's work in small, verifiable increments. Before each increment inspect the current repository, task state, and last result. Use supported tools for the next action, then validate actual effects. Record blockers and decisions. Stop for authorization, ambiguous side effects, exhausted budget or missing evidence; never infer success from a model's own claim. If scheduled follow-ups are supported in this conversation, use them rather than asking an external tool to scrape the ChatGPT page. Prepare an evidence-based context summary before context becomes exhausted.

## Limits / safety

- The manual handoff and optional Playwriter browser continuation are separate capabilities.
- Playwriter touches rendered conversation elements only after the extension is enabled by the operator. It does not read cookies, bypass authentication or access other tabs.
- The local SQLite file stores ChatGPT conversation URLs; treat these as private metadata. Telegram sends the URL only to the strictly allowlisted private chat, which is not end-to-end encrypted. Do not use this mechanism for confidential or sensitive conversations.
- The browser implementation is experimental and requires the operator to enable Playwriter on the precise ChatGPT tab and bind the intended Chrome profile. Bounded automatic `HANDOFF` to a newly opened ChatGPT conversation **has passed an attended real text-only test** with an atomic link/receipt transaction and no replay. This is separate from the manual `handoff` command, does not transfer prior tools or permissions, and is not general unattended browser control.
