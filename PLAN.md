# dsh-rollback-plugin Complete Plan

> Standalone DeepSeek Harness (dsh) plugin: session rollback + archived tasks.
> Goal: make it a **fully standalone plugin**, published to the author's own GitHub account, installable by anyone with a single command, **without modifying dsh itself**.
> This file is the implementation blueprint; once the review passes, execute the "Implementation Steps" one by one.

---

## 1. Project Goal (Plain Language)

Build an "undo button" for dsh:

- After the user sends a message in a conversation (and the AI has answered), clicking "Rollback" returns the workspace files to their state before that message, and the conversation to before that message as well.
- The old conversation that was rolled back goes into the "Archived Tasks" page, where it can be viewed.
- Publish it to GitHub so that others can install it by running `dsh plugin --profile web add <your-package-name>`.

**Hard constraint**: do not modify any dsh source code (the dsh core packages are installed from npm; use only their public capabilities).

---

## 2. Technical Conclusions (Why It Is Feasible / Where It Must Be Compromised)

### 2.1 Confirmed Prerequisites

1. **The dsh core packages are published on npm** (verified: `@deepseek-ai/dsh-agent@0.1.0-rc.6`, `@deepseek-ai/dsh-session@0.0.1-rc.1`, `@deepseek-ai/cordis@4.0.1`) -> the standalone repository can `npm install` its dependencies without depending on dsh source.
2. **dsh's plugin mechanism is fully usable**:
   - bundle = an npm package plus a `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` declaration in `package.json`.
   - Install command: `dsh plugin --profile <name> add <package>` (the CLI already has the `plugin` subcommand, `apps/cli/src/plugin.ts`).
   - The browser part of the plugin can be loaded by the web assembly (`client-modules` scans the `dsh.client` declaration -> serves `/plugins/<id>/client.js` -> injects `window.__DSH_BOOT__`).
3. **A dsh plugin ecosystem already exists on GitHub** ([vlln/plugin-registry](https://github.com/vlln/plugin-registry), [w2112515/dsh-plugin-development](https://github.com/w2112515/dsh-plugin-development), the official [RFC #1629](https://github.com/deepseek-ai/deepseek-harness/discussions/1629)); standalone bundles are the ecosystem convention.

### 2.2 Feature Comparison Against the Original Spec (PLAN.md)

The following compares, item by item, the significant features of the original delivery spec (the original project's `PLAN.md`) and marks their status under Route B (pure plugin). **The core experience (rollback + archive visibility) is fully preserved; every degradation or abandonment has an explicit reason.**

| # | Original spec feature (PLAN.md location) | Route B status | Notes |
|---|---|---|---|
| 1 | Roll files back to before the message (§1, §4.1) | ✅ Complete | Shadow Git snapshot, plugin-owned `GIT_DIR`, never touches the user's git |
| 2 | Roll the conversation back to before the message; the model cannot see rolled-back content (§2.1) | ✅ Complete | Event prefix split + `ctx.agents.create(seed)`; the new session reads only the prefix |
| 3 | Old session S1 enters the global archive set and disappears from the sidebar (§1, §2.2) | ✅ Complete | `ctx.workspaceRegistry.archiveSession` (public) |
| 4 | Archive page: view read-only conversations (§5) | ❌ Removed | Stock dsh has no archive viewer UI, and the plugin does not build its own read-only conversation rendering; archive = hidden, viewing is not provided |
| 5 | Single-turn rollback over the journal (S1/S2/beforeTree/redoTree) (§2.2, §4.1) | ✅ Complete | Plugin-owned persistent journal, including the transaction phase |
| 6 | Rollback mutex + a second click returns `rollback-in-progress` (§4.3.1) | ✅ Complete | In-process lock in the plugin + workspace-granularity lock |
| 7 | Snapshot failure: the model does not receive the prompt, the composer is restored with the original prompt + redacted details (§4.2) | ✅ Complete | The `agent/pre-step` waterfall can reject (public event); the RPC error restores the composer |
| 8 | Rollback while running: wait 0.5 seconds, then force stop (§4.3.3-4) | ⚠️ Degraded | Can only `agent.cancel()` to request a stop + wait for idle; **no forced termination** (`dispose` is a creator-private capability) |
| 9 | Permanently delete old session logs/attachments/archive records (§2.2, §5) | ⚠️ Degraded | Changed to "tombstone marking": the plugin records the deletion and the UI hides it; files on disk are kept (dsh has no delete API) |
| 10 | Automatically and permanently delete the old rollback pair (after a new prompt is accepted) (§2.2, §5) | ⚠️ Degraded | Automatically "tombstone-marks" the old S1; physical deletion is not possible |
| 11 | Restore an archived conversation (unarchive + open) (§2.2, §5) | ❌ Abandoned | Stock dsh has no unarchive; archiving is irreversible |
| 12 | Undo the rollback (restore redoTree + reverse the archive) (§2.2) | ❌ Abandoned | Reversing the archive needs unarchive (no public API) and is not possible; moreover, dsh has no archive viewer UI, so there is no visual entry point for reverting |
| 13 | Button located next to Copy on user messages (§6) | ⚠️ Adjusted | Stock dsh has no user-message-level slot; the button is attached to existing slots in the session header / input area instead |
| 14 | Only ordinary plain-text messages create rollback points; steer/images/injections do not (§2.1) | ⚠️ Partial | Images/non-text can be detected (content check); **steer cannot be durably distinguished** (stock dsh has no delivery marker, so a plugin-side heuristic or a documented statement is required) |
| 15 | Archive set consistent across refresh/reconnect/multiple tabs (§2.2, §5) | ✅ Complete | The archive set is Host-global state; the plugin only reads that set |
| 16 | Normal branching / normal manual archiving behavior unchanged (§8) | ✅ Complete | Does not touch the apiproxy fork; manual archiving already uses the public `archiveSession` |
| 17 | Recover unfinished journals on startup (§4.3) | ✅ Complete | Plugin-owned manifest + phase; a startup scan is possible |
| 18 | Failure compensation (restore failure / archive failure -> redoTree compensation) (§4.3.6-7) | ✅ Complete | Logic inside the plugin, no dependency on the core |

### 2.3 One-Sentence Summary of the Trade-offs

**The core feature — rollback — is 100% usable and consistent with the original spec; the "housekeeping" features (forced stop, permanent deletion, restore, undo rollback, read-only viewing) are degraded or abandoned under the pure-plugin constraint** — this is the inevitable cost of "not modifying dsh itself"; §2.2 annotates the reason for each item, and these trade-offs were accepted during design review.

---

## 3. Package Structure Design

### 3.1 What to Keep and What to Rewrite (based on the current working tree)

The current working tree already has 5 plugin packages, but some of them depend on "new APIs that dsh has not yet published" (terminate/unarchive/delete/removeImage/user-message slot), so they must be rewritten to use only public APIs:

| Package | Current state | Route B handling | Main changes |
|---|---|---|---|
| `session-fork` (prefix split capability) | Uses `ctx.agents.create` + the public `seed`, **already a pure plugin** | ✅ Migrate directly | None |
| `conversation-undo` (core rollback) | Depends on `agents.terminate` (unpublished) | ✏️ Rewrite | `terminate` -> `cancel()` + wait; keep the rest (Shadow Git, journal) |
| `session-archive` (archive capability) | Depends on `unarchiveSession`/`delete`/`removeImage` (all unpublished) | ✏️ Rewrite | Drop restore/delete; archiving becomes one-way + read-only |
| `ui-conversation-undo` (rollback button) | Depends on the new `user-actions` slot (unpublished) | ✏️ Rewrite | Attach the button to existing slots such as `conversation.session.header.actions` |
| `ui-settings-archive` (archive page) | Depends on remote assembly in `api/remotes` (unpublished) | ✏️ Rewrite | The plugin `$mount`s its own remote inside `apply`; list + tombstone delete only, no read-only viewing / restore / undo rollback |

### 3.2 Proposed Final Structure (may be fine-tuned during implementation)

```
dsh-rollback-plugin/                    # this repository root (= the future GitHub repository)
├── package.json                        # root: pnpm workspace + build scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── rollback-fork/                  # prefix split (migrated from session-fork)
│   ├── rollback-archive/               # archive capability (rewritten, one-way)
│   ├── rollback-undo/                  # core rollback (rewritten)
│   ├── client-rollback-button/         # rollback button (rewritten, attaches to existing slots)
│   ├── client-rollback-settings/       # archived tasks page (rewritten, mounts its own remote)
│   └── bundle-rollback/                # installable bundle (patch + dependency declarations)
├── docs/                               # usage documentation (English/Chinese)
└── examples/                           # minimal runnable cordis.yml demo
```

> Whether package names should actually be `@<your-scope>/dsh-rollback-*` or keep the `@deepseek-ai/dsh-*` naming must be decided during review (see §8 review point 2).

---

## 4. Key Technical Design (basis for implementation)

### 4.1 Rolling Back Files: Shadow Git (pure plugin, never touches the user's git)

- Before each rollback-eligible message reaches the model, the plugin captures a file snapshot of the current workspace (`beforeTree`).
- Snapshots are stored in the plugin's own independent `GIT_DIR` (for example `$DSH_HOME/rollback/<workspace>/shadow.git`); the plugin **never writes the user's `.git`, HEAD, branch, stash, or index**.
- When rollback is clicked, the current state is captured (`redoTree`), and then the workspace is restored to `beforeTree`.
- Supported scope: files that git can record and that are not ignored by `.gitignore`; ignored content/submodules are not restored.

### 4.2 Rolling Back the Conversation: event prefix split + `ctx.agents.create`

- Read the source session's event stream (`ctx.sessions.get(id).events` or `ctx.sessionPersistence.inspect(id)`).
- Find the `turn/start` of the turn that owns the target `user/message`, and take the complete prefix before it as the `seed`.
- `ctx.agents.create({ sessionId: newId, seed, meta: { parentSession, cwd, ... } })` creates the new session (public API; `CreateAgentOptions` requires only `sessionId`).
- The new session is attached to the original workspace (`workspace.attachSession`).
- The old session goes through `ctx.workspaceRegistry.archiveSession(oldId)` -> it disappears from the sidebar.

### 4.2a Eligibility Check for Messages (agent/pre-step interception)

- Listen to `agent/pre-step` (a public waterfall event already defined in `runtime-types.ts`; the payload contains `agent/messages/turn/step/signal`) and decide/capture before the message reaches the model.
- Eligible: main session, `source.kind === 'user'`, content consisting entirely of text blocks (images/attachments/injections are excluded by content and source shape).
- **steer cannot be durably distinguished** (stock dsh has no delivery marker): the plugin either captures all messages uniformly at `pre-step` (steer included), or only arms a rollback point after the browser confirms an "ordinary send". Choose one during implementation and state it in the README (comparison table #14).
- Capture failure: the waterfall returns `reject`, the message is not written as `user/message` and does not reach the model; the RPC returns a readable error and the browser restores the composer with the original prompt + redacted details (comparison table #7).

### 4.2b Single-Turn Journal, Locks, and Startup Recovery

- Each active rollback pair is stored in a plugin-specific directory (journal = `manifest.json` + `shadow-git/`), with the same fields as the original spec: `logicalConversationId`, `workspacePath`, `sourceSessionId`, `rollbackSessionId`, `messageId`, `beforeTree`, `redoTree`, phase, generation, schemaVersion (comparison table #5).
- Mutual exclusion: lock by `logicalConversationId` and normalized workspace path; a concurrent second click returns `rollback-in-progress` (comparison table #6).
- Failure compensation: if restoring `beforeTree` fails -> dispose the new session and compensate with `redoTree`; the same applies to an archive failure; if compensation also fails, keep the journal for startup recovery (comparison table #18).
- Startup scan: unfinished phases are continued, or reported with an actionable error, based on the manifest + the actual archive set + the Shadow Git trees; an unknown intermediate state is never displayed as success (comparison table #17).

### 4.3 Browser Communication: the plugin mounts its own remote (no dependency on `api/remotes`)

- The host plugin class extends `TypertRemoteService` and marks methods with `@Remote(...)` (`@deepseek-ai/dsh-typert-protocol` is an already-published public mechanism).
- The browser plugin's `apply` calls `ctx.remote.$mount(<the generated self-contained remote contribution>)` itself — `$mount` is a public API (`packages/typert/protocol/src/types.ts:228`), so **there is no need** to change dsh's `api/remotes` assembly manifest.

### 4.4 Archive Page

- List: iterate `ctx.workspaceRegistry.archivedSessionIds` (public getter) and show the title and archive time.
- View read-only conversation: **not provided** (stock dsh has no archive viewer UI and the plugin does not build one; archive = hidden).
- Restore: **not provided** (stock dsh has no unarchive).
- Delete: **tombstone marking** — the plugin records a "deleted" list under `$DSH_HOME/rollback/` and the UI filters those entries out; files on disk are not touched.
- Undo rollback: **not provided** (reversing the archive needs unarchive, and there is no archive viewer UI).

### 4.5 Stopping the AI Before Rollback (degraded version)

- Check `ctx.agents.get(id).status`; when it is not idle, call `agent.cancel({ kind: 'user' })` (public).
- Poll `whenIdle()` to wait for the stop; on timeout, either warn "could not stop; continuing the rollback anyway (at your own risk)" or give up.
- Forced termination is explicitly not provided (`dispose` is a creator-private capability).

---

## 5. Implementation Steps (execute one by one after review)

### Phase 0: Repository initialization
1. Use `pnpm create dsh-plugin` (if available) or manually scaffold a pnpm workspace skeleton.
2. Root `package.json`: `type: module`, workspaces, peers such as `@deepseek-ai/cordis`.
3. Verify that all dependencies come from npm (published versions of `@deepseek-ai/dsh-*`).

### Phase 1: Migrate `rollback-fork` (pure plugin, smallest change)
1. Copy the `session-fork` source and tests from the current working tree; adjust the package name.
2. Run `pnpm install && pnpm test` until green.

### Phase 2: Rewrite `rollback-archive` (one-way)
1. Remove the `unarchiveSession`/`delete`/`removeImage` calls.
2. Archiving = `archiveSession` + read-only inspect; deletion = tombstone list.
3. Add tests (the original package had 0 tests; add: archive list, read-only, tombstone filtering).

### Phase 3: Rewrite `rollback-undo` (core)
1. `agents.terminate` -> `cancel()` + `whenIdle()` wait.
2. Keep Shadow Git, the journal state machine, and failure compensation.
3. Add/update tests (including the degraded path for "rollback while the AI is running").

### Phase 4: Rewrite the two client packages
1. Attach the button to an existing slot (`conversation.session.header.actions`); the UI copy should say "roll back the most recent message".
2. The archive page mounts its own remote; list/view/tombstone delete.
3. Build `lib/client.js` (`tsdown` bundle).

### Phase 5: Bundle assembly
1. `packages/bundle-rollback/`: `cordis.patch.yml` registers 5 packages (3 host + 2 client, `dshHomePath` config).
2. Complete dependency declarations (including the inserted client packages, for `client-modules` resolution).

### Phase 6: Verification
1. `pnpm run typecheck`
2. vitest green in every package
3. `verify-cordis-config` passes for the bundle patch
4. Local simulated install: `dsh plugin --profile web add <local package>` + `dsh --profile web --dump-config`
5. End-to-end manual test (requires `DEEPSEEK_API_KEY`): send a message -> modify files -> roll back -> files and conversation are restored, and the old session appears in the archive page.

### Phase 7: Release
1. Initialize git, write the README (including installation/uninstallation/prerequisites/known limitations).
2. Push to GitHub -> `npm publish` (or let users run `dsh plugin add git+https://...` directly).
3. The README must state: the dsh version must include "archiving, cancel, existing header slot" (that is, the currently published version already satisfies this).

---

## 6. Acceptance Criteria

- [ ] Standalone repository, zero dependency on dsh source (install `@deepseek-ai/dsh-*` only from npm).
- [ ] Installs with a single `dsh plugin --profile web add <package>` command.
- [ ] After rollback: files are back to before the message, the conversation is back to before the message, and the old session appears in the archive page (comparison table #1-#3).
- [ ] The archive page can list archived sessions and can tombstone-delete them (comparison table #4, #9).
- [ ] The single-turn journal holds: S1 is archived, S2 inherits the prefix, beforeTree/redoTree are linked (comparison table #5).
- [ ] A concurrent rollback click returns `rollback-in-progress` and the UI stays pending (comparison table #6).
- [ ] Snapshot failure: the model does not receive the prompt, and the composer is restored with the original prompt + redacted details (comparison table #7).
- [ ] Rollback while the AI is running: request a stop and wait; if it does not stop, say so explicitly and do not pretend it succeeded (comparison table #8).
- [ ] Unfinished journals can be identified and handled after a restart (comparison table #17).
- [ ] The failure compensation paths (restore failure/archive failure) are covered by tests (comparison table #18).
- [ ] All tests and typecheck pass inside the standalone repository (no dependency on the dsh working tree).
- [ ] The documentation (README in English/Chinese) is complete and includes the degradation/abandonment list from §2.2.

---

## 7. Risks and Limitations (honest list)

1. **Degraded features**: forced stop -> requested stop, permanent deletion -> tombstone. **Abandoned features**: restore archive, undo rollback, read-only archive viewing. See §2.2 comparison table #4, #8-#12.
2. **Button location**: not next to the user message but in the session header/input area; the semantics must be explained in the README.
3. **Archiving is irreversible**: an archived session cannot be restored, so the UI must state this clearly.
4. **Shadow Git boundaries**: ignored files, submodules, and unregistered background writes are not guaranteed; a rollback overwrites later local modifications to supported paths.
5. **End-to-end verification needs a key**: without `DEEPSEEK_API_KEY` only unit/assembly verification can run; the real flow needs an environment with a key.
6. **Version drift**: the evolution of dsh npm versions may affect the `ctx` service signatures; pin the peer version range before release.

---

## 8. Review Points (need author/maintainer confirmation)

1. **Package naming scope**: `@<GitHub username>/dsh-rollback-*` or `@deepseek-ai/dsh-*`? (The former is recommended, for an independent identity.)
2. **Repository name**: `dsh-rollback-plugin`? (Changeable.)
3. **Whether the bundle lives in the same repository**: recommended yes (monorepo `packages/bundle-rollback`); a single repository then publishes multiple npm packages.
4. **Confirming the degraded trade-offs**: are the four degradations in §2.3 acceptable (verbally accepted during review, confirmed in writing here)?
5. **Whether a headless version is needed**: is web-only (with UI) enough, or should an extra host-only bundle be provided? (Default: web first.)
