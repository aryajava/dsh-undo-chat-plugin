# Current Feature Baseline (later updates must not remove these unintentionally)

> Baseline date: 2026-08-24 (re-verification of the /undo node axis and its linkage with the native trajectory). This document records behavior contracts that are already implemented and user-facing; **it is not a TODO list or a design draft**. Check this table before changing related code; if an item genuinely has to be removed or changed, the change description must explicitly state the compatibility impact and the user confirmation.

## 1. Installation and Boundaries

- This repository is a standalone plugin for dsh and does not modify dsh's own source code; every capability goes through published dsh APIs and bundle injection.
- The bundle assembles rollback, archiving, the browser rollback UI, the archive settings page, tool cards, and the reasoning fold bar together.
- Rollback snapshots use the plugin-private Shadow Git and journal, and **never read, rewrite, or commit the user's `.git`**.
- File restore only covers content inside the session workspace (the git worktree boundary); files outside the workspace are not in rollback scope.

## 2. Conversation Rollback

### Rollback Points and Safety Conditions

- Every accepted, plain-text, non-steer user message saves a "before" workspace snapshot before model execution and creates an `armed` rollback point; after the turn ends it saves an "after" snapshot and transitions to `ready`. Rollback is therefore possible even while the AI's reasoning or tool execution has not finished; the transaction stops the current Agent and its running tools first.
- Non-plain-text messages and steer messages do not create rollback points; an accepted but unfinished plain-text turn is a rollback-eligible point.
- If a snapshot cannot be created, model acceptance for this message is rejected; after stopping, the original prompt and the redacted failure reason are restored to the input box. A prompt that cannot be rolled back safely must never be sent silently.
- Rollbacks within the same session or the same workspace are serialized; when the session is busy, the workspace is unsupported, the point has expired, or a restore is in progress, the request must be rejected explicitly instead of overwriting data.

### Entry Points and Navigation

- The currently rollback-eligible user message has a return-arrow icon below it, adjacent to the existing message actions; it appears only on the message that corresponds to the current rollback point, stays usable while the AI is running, and is re-injected automatically after React re-renders or virtualization.
- The session header has a "Rollback" entry; it is shown when a rollback point exists and stays usable while the AI is running. The rollback point is refreshed continuously during a run and read once more on click, so the rollback does not land on a stale previous message from the cache.
- Typing the exact `/undo` opens the rollback timeline in the browser; the host also keeps a `/undo` command fallback path for rolling back the latest completed message directly.
- After a successful rollback the source session is archived and hidden from the sidebar, and the client automatically opens the resulting child session; even if the archive projection of a multi-step rollback briefly clears the current selection, the target session is reopened within the stabilization window, and the UI must not fall back to the initial "choose a workspace" screen or require the user to find that session manually.

### Rollback Results

- The single-message entry rolls back to **before** that prompt; the `/undo` timeline instead **keeps the selected node** and removes only the prompts, replies, and tool calls after it. Selecting the current latest node is a valid zero-step operation.
- A rollback restores both the corresponding workspace files and the conversation event prefix; the model does not see the removed prompts, replies, or tool calls.
- Consecutive rollbacks form a complete lineage and are not limited to a single one: each rollback produces the next-generation session and inherits the earlier rollback points that are still reachable.
- When the user submits a new ordinary prompt in the post-rollback session, the old rollback edge loses its "undo rollback" eligibility, but the archived source sessions and the timeline journal are not deleted automatically; archives are deleted only when the user does so explicitly in "Archived Tasks". The new branch keeps its own subsequent rollback capability.

## 3. `/undo` Node Timeline

- The initial window is a compact, centered vertical node axis; it can be closed by clicking the overlay or pressing `Esc`. The window background, border, nodes, and connector lines follow dsh's light, dark, or system theme.
- The timeline lists every reachable rollback point in the current lineage; after selecting a point, the user can roll back to it in one continuous operation instead of clicking level by level manually. As the node count grows, spacing is compressed automatically and the overall view is pulled back, and the list is never truncated to a fixed three points or a fixed count.
- Hovering a node or giving it keyboard focus expands two fan-shaped "petal" actions with SVG icons; hovering or focusing the current petal enlarges it and shows a short text label while the other petal stays or shrinks; both collapse once the pointer leaves the node and petal area. The petals are annular sectors with an inner arc and no pointed tip aimed at the node, and they stay compact.
- When a node is selected it gains focus and zooms in slightly, with a blurred background; clicking an empty area of the window exits the petal interaction state without closing the timeline.
- The two fan actions are "Rollback" and "View dsh trajectory"; accessible names, `aria-pressed`, and keyboard operation remain available.
- "View dsh trajectory" closes the node axis and opens dsh's native "Trajectory" page, without reimplementing tools, commands, or diff details. It locates the turn that owns the selected prompt and, from that USER row up to but not including the next USER row, applies a low-contrast full-block highlight and a continuous left marker line to that turn's USER / assistant / tool rows.
- The node axis connector lines and the message-level rollback arrow must keep visible contrast and theme-color fallbacks under different themes.

## 4. Undo Rollback

- The new session created by a successful rollback shows a single `↩ Rolled back <prompt preview> [Undo rollback]` fold bar above the input box; ordinary sessions do not show it, and it is hidden while a turn is running.
- A long prompt can be expanded / collapsed; the fold bar width aligns with the composer card.
- "Undo rollback" restores the complete pre-rollback conversation and files, then archives the current rollback child session; after undoing one layer, if another layer is still undoable, the fold bar moves forward to that layer, until no undoable layer remains.
- Rolling back a prompt the AI has not yet completed and then undoing that rollback resubmits the original prompt as a new user message and lets the AI respond normally; it must not produce an empty prompt and must not register the same interrupted prompt twice in the lineage. Timeline rollbacks afterwards must still stop exactly at the selected node.
- Before undoing, the workspace must be verified to still match the post-rollback snapshot. If the user has modified the workspace, return `workspace-diverged`; never overwrite the user's new modifications with the undo.
- After a new prompt is accepted, the old undo edge expires via `revokeExpired` and the fold bar disappears; no stale recovery entry is left behind in the new branch, and the old archived tasks are not deleted because of it.

## 5. Archived Tasks (Settings → Archived Tasks)

- Lists all archived sessions: title, archive time, creation time, and workspace.
- The user / assistant text record of an archived session can be viewed read-only in place.
- "Restore" forks the archived session into a new visible session and opens it automatically; the original archive entry is kept, so restore can be repeated.
- Single-item "Delete" permanently deletes the session log after a second confirmation; if the session is still live / the backend does not support it, an explicit rejection is returned.
- "Delete all" also requires a second confirmation and runs as one batch request; if some deletions fail, the success and failure counts are shown.
- Archived tasks produced by a rollback are not deleted automatically when the user sends an ordinary prompt in the new branch; permanent deletion only happens after the user explicitly confirms "Delete" or "Delete all".
- Archive entries associated with a rollback journal show states such as cleanup pending or recovery required, instead of disguising risk states as ordinary archive entries.

## 6. Session Reading Experience

- Every prompt turn with a collapsible trajectory has a "Reasoning and Actions" fold bar covering Think, intermediate narration, context injection, and tool calls; the final conclusion and the statistics tail always stay visible.
- A running turn stays expanded and shows a running indicator; when the turn ends and the user's view is following the bottom, it collapses automatically. Manual expand / collapse takes priority over the automatic behavior; turns loaded from history are expanded by default.
- When a tool execution fails, the terminal failed-tool card and the final error explanation must stay visible; the Think, context injection, and intermediate actions before it can still be collapsed by the "Reasoning and Actions" fold bar. The very first Think also belongs to that collapsible range, and collapsing must not swallow the final output.
- Expanded tool cards are colored by type: bash is always a near-black terminal, pwsh is PowerShell blue, edit / write green, read purple, grep / glob blue, web_search / web_fetch cyan, run_code amber; readability must hold in both the light and the dark theme.

## 7. Self-Update

- `/update` is a user-triggered update of the source workspace: `git pull --ff-only` → dependency install → build.
- When the workspace is already up to date, install and build are skipped; any step that times out or fails must be reported clearly, and the update must never run silently in the background.
- After an update, prompt the user that dsh must be restarted before the new packages are loaded.

## 8. Reliability and Recovery

- The journal keeps transaction states such as `armed`, `ready`, `quiescing`, `restoring`, `complete`, `revoking`, `cleanup-pending`, and `recovery-required`. On host restart, transactions that can be determined from the archive state and snapshot evidence are recovered; when that determination is impossible, an explicit "recovery required" state is entered and further risky operations are forbidden.
- `revokeExpired` only means that the completed rollback edge no longer allows an undo; it is not equivalent to deleting the archive or the journal. An undo replay while running inherits only the predecessor node of the interrupted prompt, and the new message then creates the single new node.
- Rollback / undo use diff-path restore, Shadow Git's untracked cache / split index, state prewarming, and next-generation pre-initialization to avoid unnecessary full checkouts on large workspaces.
- All plugin-side persistence writes must preserve atomic-write and `EPERM` / `EBUSY` / `EACCES` retry semantics on Windows.

## 9. Verification Record of 2026-08-24

- Automation: `pnpm run typecheck`, `pnpm test` (16 test files, 88 tests), and `pnpm run build` all pass.
- Real browser verification: after typing `/undo` and selecting a node, clicking "View dsh trajectory" closes the node axis and opens dsh's native "Trajectory" page; the full-block marking logic for the selected turn is covered by client tests.
- Reading the archive list, its metadata, and the view / restore / delete entry points were checked in the browser; to avoid damaging the user's existing data, permanent single-item deletion and delete-all were not executed against real archives, and their confirmation, success / failure, and batch semantics are covered by automated tests.
- The branch detection, command order, skip, and failure semantics of `/update` are covered by automated tests; this round did not actually run `git pull`, dependency install, or a restart replacement in the current workspace.

## 10. Minimum Acceptance for Every Related Change

1. Do not delete or silently change the behaviors above; for any product-decision exception, update this document first and explain it in the PR / handoff.
2. Run `pnpm run typecheck`, `pnpm test`, `pnpm run build`.
3. For rollback UI changes, verify at least in the browser: message arrow, session header entry, `/undo` timeline, node selection, petal hover, automatic navigation after rollback, undo rollback; if the trajectory linkage changes, verify that the native "Trajectory" page opens and that the selected turn is fully marked.
4. For archive / trailfold / toolcards changes, verify the settings page operations, the collapse semantics, and card readability in the light / dark themes respectively.
5. For data transaction changes, verify consecutive rollbacks, layer-by-layer undo, undo replay after a rollback while running, expiry of the old undo edge after sending a new prompt while archives are retained, and rejection of undo when the workspace has been modified.

## 11. Code Ownership Quick Reference

| Capability | Main implementation location |
| --- | --- |
| Rollback lineage, Shadow Git, journal, `/undo` / `/update` | `packages/rollback-undo` |
| Session fork | `packages/rollback-fork` |
| Archive list, read, restore, delete | `packages/rollback-archive`, `packages/client-rollback-settings` |
| Header / message arrow, undo bar, `/undo` timeline | `packages/client-rollback-button` |
| Reasoning and Actions fold bar | `packages/client-rollback-trailfold` |
| Tool card colors | `packages/client-rollback-toolcards` |
| Bundle assembly and conflict disabling | `packages/bundle-rollback/cordis.patch.yml` |
