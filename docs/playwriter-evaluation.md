# Playwriter browser integration

Mission Relay connects to the owner's already authenticated Chrome through
the official Playwriter extension and `playwriter@0.9.0`. It does not copy
browser profiles, expose the local relay over a public tunnel, install a second
browser daemon or use a private ChatGPT API. Only explicitly Playwriter-enabled
tabs are accessible. A browser profile's connected-tab inventory is **not**
evidence of Chrome tab-group membership.

## Setup and binding

1. Install and enable [Playwriter](https://playwriter.dev/docs/installation)
   in the intended Chrome profile. Enable the exact ChatGPT tab.
2. Install project dependencies with `npm ci` and build with `npm run build`.
3. Confirm the available profile, then pin it as the profile in which Goal
   Chats are opened. Every new Goal Mission inherits this binding. Do not
   guess profile identity from an account email or a tab group.

```sh
node dist/cli.js browser-list
node dist/cli.js telegram-anchor --url <ChatGPT-conversation-URL> --browser-id <approved-browser-id>
node dist/cli.js browser-binding-health <mission-id>
```

A zero enabled-tab count does **not** mean the Chrome window closed. Restore
Playwriter access to the original authorized tab; do not silently substitute
another tab or resend an uncertain request. All browser operations require a
valid local profile binding.

## Execution contract

- The approved Goal's repository and active work package bound the execution
  scope. Browser access does not grant filesystem or account permissions.
- Before a Send, SQLite reserves the unique request key, exact user-prompt
  SHA-256 and conversation lock. A submitted or ambiguous Send cannot be
  replayed through the composer.
- The newest visible prompt must match the reserved hash exactly, including
  text across hyperlinks and authored line breaks. Assistant turns are checked
  for a stable complete response and a final `[MISSION_RELAY:...]` flow
  marker. A matching marker is not independent Goal acceptance.
- Normal in-progress DOM observation occurs every **60 seconds**. The default
  turn window is 60 minutes; a genuine connection-interrupted banner can
  extend it once within a four-hour absolute cap. An explicit shorter timeout
  is respected.
- A visible delivery-timeout or stream-error **Retry** control may trigger
  at most one UI Retry for the *already submitted message*, after the exact
  prompt and conversation are revalidated. The retry intent commits to SQLite
  **before** the click and survives Worker restarts. An owner pause or
  maintenance drain defers the click. A stopped uncertain request is settled
  with `recover` (see [Operations](operations.md)), which never clicks Send.
- Each ChatGPT conversation permits at most **8 observed Relay Sends**.
  Further work uses a distinct, independently verified Chat URL after a
  bounded handoff. A newly created tab is retained until the destination
  request/answer is committed. Only proven superseded Relay-owned tabs may
  later be retired; never close human tabs or guess tab ownership.

## Read-only diagnosis and recovery

```sh
node dist/cli.js pi-health
node dist/cli.js browser-binding-health <mission-id>
node dist/cli.js recover <mission-id>
node dist/cli.js channel-status
```

If the response is still generating, or its complete answer and original
prompt cannot be independently correlated, keep the original reservation
uncertain. Do **not** reset the Mission, clear a browser lock, click Send again,
or run a second controller. See [Telegram](telegram.md) for the owner command
surface and [Operations](operations.md) for maintenance, backups and
original-message recovery.

Playwriter's own [remote-control capability](https://playwriter.dev/docs/remote-control)
is a separate upstream feature, not a Mission Relay permission to execute
arbitrary Telegram click/type/scroll commands. Historical exploratory tests
and version-specific incidents belong in Git history or private audit
receipts, not in this current integration contract.
