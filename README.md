# dsh-undo-plugin

[![CI](https://github.com/aryajava/dsh-undo-chat-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/aryajava/dsh-undo-chat-plugin/actions/workflows/ci.yml)

> This repository is a personal port of [23swccp/dsh-undo](https://github.com/23swccp/dsh-undo) (MIT), retargeted to dsh `0.2.1-rc.3`. Original copyright belongs to the upstream authors; see [LICENSE](LICENSE).

## Overview

[dsh-undo-plugin](https://github.com/aryajava/dsh-undo-chat-plugin) is a conversation-undo plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness), published from the repository `dsh-undo-chat-plugin`: a single `/undo` rolls the **workspace files and the conversation together** back to before the latest completed message; rolled-back sessions land in "Settings → Archive Tasks" for management (view / restore / permanent delete / delete all). Made a mistake? The "revoke rollback" strip above the composer fully restores it.

The plugin ships as an **installable bundle**: a standalone workspace that never patches the dsh codebase and uses only the public dsh APIs published on npm (`@deepseek-ai/dsh-*@0.2.1-rc.3`). File rollback goes through a plugin-private Shadow Git snapshot (its own `GIT_DIR`, never your `.git`).

## Features

### Conversation undo (rollback)

- **Four trigger points**: the rollback icon button in the qualified user message's actions row (the enter-key glyph, right next to Copy), the session-header rollback button, the `/undo` slash command, and the strip above the composer
- Exact `/undo` opens a lineage node axis: hover or keyboard-focus a node to reveal the **Rollback** and **View dsh Trajectory** petals; the former rolls back to that node in one step, while the latter opens dsh's native Trajectory view focused on the full turn the selected prompt belongs to

<img width="629" height="717" alt="The /undo node axis with its Rollback and View dsh Trajectory petals" src="https://github.com/user-attachments/assets/84f1bcd0-530b-4cc8-b40b-216345214cfc" />

- The message-level button appears only on the user message the rollback point currently targets (exact message-id match) and follows the point as it moves; disabled while running, DOM-patch injected, self-healing across React re-renders
- The file tree is restored from a private Shadow Git snapshot; the conversation is forked into a new Session whose seed is the complete event prefix *before* the target message — the model never sees the reverted prompt, reply, or tool calls
- The old Session is archived automatically (it leaves the sidebar) and the UI navigates to the child Session
- Snapshots are captured at `agent/pre-step`; a capture failure rejects the step (the model never receives the prompt) and refills the composer draft with the original prompt plus a redacted reason

<img width="1114" height="682" alt="The rollback entry points in the session header and the composer strip" src="https://github.com/user-attachments/assets/f27676a4-b844-491c-9686-668bb4a55d7c" />

You can also click the rollback icon under a sent prompt to roll back directly.

<img width="713" height="309" alt="The message-level rollback icon button under a user prompt" src="https://github.com/user-attachments/assets/80c348a2-fc42-4530-9b39-2b73e1039a8c" />

### Revoke rollback

- The `↩ Rolled back <preview> [Revoke rollback]` strip appears only after a rollback and disappears once a new prompt is accepted
- A full reverse transaction: it first verifies the workspace is untouched (a diverged workspace is refused with `workspace-diverged`, never overwritten), then restores the source Session and files, and re-arms the rollback point — rollback and revoke are symmetric and repeatable
- The `restoring` / `revoking` journal phases are recovered deterministically on startup from the on-disk journal evidence

<img width="1220" height="387" alt="The revoke-rollback strip above the composer" src="https://github.com/user-attachments/assets/faf026a0-97d0-4f56-82a2-acbae0a09e1e" />

### Archive tasks (Settings → Archive Tasks)

- Lists every archived Session (title / archived time / created time / workspace) with a read-only transcript viewer
- **Restore**: forks an archived conversation back into a new Session (repeatable; the archive entry is kept)
- **Delete**: permanently removes that session's on-disk log directory; a busy agent is cancelled and awaited idle first
- **Delete all**: one batch RPC with a double-confirm dialog; partial failures report "deleted X, Y failed"

<img width="987" height="837" alt="The Archive Tasks settings page" src="https://github.com/user-attachments/assets/3ea2b7a0-9507-45c5-a236-4c4dae9a88da" />

### Reasoning and actions fold

- Every prompt turn gets its own "reasoning & actions" collapse bar: the turn's Think steps, intermediate narration, context injections, and all tool calls fold away together; **the final conclusion and the stats row never fold**
- A running turn shows a "running" hint and stays expanded; once the turn closes while the view is following at the bottom it auto-collapses; manual clicks always override
- Turns without a conclusion (e.g. ending on a failing tool call) never fold — errors stay visible; history loads expanded
- Pure CSS/DOM injection keyed on the renderer's stable `data-chat-flow-kind` boundaries (user / assistant-step / tool-call / turn-tail); React-owned node structure is never touched

<img width="887" height="293" alt="The per-turn reasoning and actions fold bar" src="https://github.com/user-attachments/assets/7ffde842-b5a8-41e8-9361-8e7411c669f8" />

### Tool card colors

- Every expanded tool-call card in a conversation is tinted by tool type: the **bash terminal card stays near-black** (kept dark even under the light theme), the **pwsh terminal card gets the PowerShell-window blue**, and the rest carry theme-coordinated tints (edit green / read violet / search blue / web teal / code amber)
- Pure CSS injection keyed on the stable `data-*` hooks the stock renderer already publishes (`data-tool`, `data-terminal`, `data-diff`, …) — no hashed class names, React re-renders re-apply automatically

<img width="1025" height="655" alt="Tool-call cards colored per tool type" src="https://github.com/user-attachments/assets/6aac899b-d6c7-449b-83b8-a4b904b5c932" />

### Self-update

- `/update` in any session runs `git pull --ff-only` → `pnpm install` → `pnpm run build` in one pass (per-step timeouts; skips install/build when already up to date); restart dsh to activate
- No background auto-update — updating always starts from an explicit user action; `--ff-only` never rewrites local commits

<img width="1058" height="225" alt="The /update command output" src="https://github.com/user-attachments/assets/66ee5ddc-6d84-4caf-acd6-fa42900d4658" />

### Performance and reliability

- Measured on a ~7,400-file workspace: **rollback and revoke each complete in about 500 ms** (previously 30–40 s perceived)
- Key optimizations: single-`diff-tree` path-limited restore, `untrackedCache` + `splitIndex`, fork ∥ restore parallelism, stat warm-up plus next-generation prearm
- Windows-friendly atomic writes: `EPERM` / `EBUSY` / `EACCES` renames retried with backoff; failed temp files are cleaned up

## Installation

### Prerequisites

- Node.js (`^22.19 || >=24`) and dsh `0.2.1-rc.3` (the desktop DeepSeek Harness and `dsh web` share one runtime)
- The browser half needs the `dsh-web-app` surface (the web profile provides it by default; headless profiles may drop the four `client-rollback-*` rows from the bundle patch)

### Install

The newest version on npm is `0.1.0-rc.8`, which targets dsh `0.1.x` only — the dsh `0.2.x` install gate rejects it on peer ranges. For dsh `0.2.1-rc.3`, build from source and install the local path described below.

#### Install from source (developers)

```sh
git clone https://github.com/aryajava/dsh-undo-chat-plugin.git
cd dsh-undo-chat-plugin
pnpm install
pnpm run build
dsh plugin --profile web add ./packages/bundle-rollback
```

Installing the entry package is enough: the bundle enters the profile as a `link:`, and its seven `@dsh-undo/*` dependencies resolve through that checkout's own workspace instead of being linked one by one. On the desktop app, swap `--profile web` for `--profile desktop` (or install the same path from the in-app plugin market or plugin manager).

After restarting dsh: the session header gains the rollback button, `/undo` opens the node axis to select a rollback point or inspect the selected turn in dsh's native Trajectory view, the Settings dialog gains the Archive Tasks page, every turn gains the reasoning and actions fold bar, and expanded tool-call cards are colored per tool type.

### Update

npm installs: run `dsh plugin --profile web update dsh-undo-plugin`, then restart dsh. Git-clone installs: run `/update` in any session, then restart dsh. Manual equivalent:

```sh
git pull && pnpm install && pnpm run build
```

## Package layout

The npm entry package is `dsh-undo-plugin` (`packages/bundle-rollback`); the internal packages are published as `@dsh-undo/*`:

| Package | Role |
|---|---|
| `packages/rollback-fork` | Session fork capability: exact completed-turn / before-user-message Agent branches |
| `packages/rollback-archive` | Archive capability: list, read-only view, restore, permanent delete, delete-all |
| `packages/rollback-undo` | Shadow-Git journal + rollback/revoke orchestration + the `/undo` and `/update` commands |
| `packages/client-rollback-button` | Browser: session-header rollback action and the revoke strip (self-mounted Remotes) |
| `packages/client-rollback-settings` | Browser: Archive Tasks settings page (self-mounted Remotes) |
| `packages/client-rollback-toolcards` | Browser: per-tool-type colors for expanded tool-call cards (CSS-only injection) |
| `packages/client-rollback-trailfold` | Browser: per-turn reasoning and actions fold bar (DOM injection) |
| `packages/bundle-rollback` | Installable bundle: `cordis.patch.yml` + dependency manifest |
| `packages/typert-protocol` | Vendored `@deepseek-ai/dsh-typert-protocol` source (required by the typert generator, see below) |

## Development

```sh
pnpm install
pnpm run typecheck   # builds host artifacts (typert generation) then checks the client face
pnpm test            # vitest, 12 files / 65 tests
pnpm run build       # host lib + client bundles (lib/client.js)
```

### Why the vendored typert-protocol and the generator patch

The typert generator recognizes `Remote` / `TypertRemoteService` only when the declaring package is workspace-registered, and it maps export targets back to `src/`. Against npm-resolved dsh packages two things were required:

1. `packages/typert-protocol` vendors the protocol source; `pnpm-workspace.yaml` overrides every dsh package to resolve it (`workspace:^`), and `tsconfig.base.json` maps `@deepseek-ai/dsh-typert-protocol` to `src/`.
2. `patches/typert-generator-workspace-only.patch` (applied via `patchedDependencies`) restricts typert map/context collection to workspace-registered files — otherwise npm-resolved dsh twins (e.g. two `dsh-session` instances from circular peers) duplicate the map declarations and fail generation.

## Limitations

- Rollback restores files inside the session workspace only (the git worktree boundary); agent writes outside the workspace are not covered.
- Steer-message exclusion is best-effort: the durable side has no `delivery` field in rc.6, so the source-kind + text-content check is the boundary.
- Admission failures are surfaced by polling once when the turn stops (the rc.6 api-remotes allowlist cannot forward push events).

## License

[MIT](LICENSE)
