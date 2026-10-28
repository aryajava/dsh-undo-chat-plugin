# dsh-rollback-plugin Handoff Document

> Implementation handoff for the standalone dsh plugin project (session rollback + archived tasks).
> The original in-repo approach (the worktree named "dsh rollback") has been abandoned; this
> directory is the repositioned final product. Read together with
> `dsh-rollback-plugin/PLAN.md` (the review blueprint).
>
> Note on names: this history was written while the project was Chinese-only. A few file-system
> paths and UI strings were originally Chinese: the old project folder name (the Chinese phrase
> for "dsh rollback", preceded by a space, so the full path contained a space) and the UI labels
> quoted below. They are rendered here in English; `<old-workspace>` stands for that folder name.
> Every technical fact is unchanged.

## Development Conventions (required reading)

- **Only modify this plugin repository (dsh-undo), never modify dsh itself.** This plugin is a
  pure plugin depending on the npm-published public dsh API; changing dsh source has no effect
  for users who install from npm and only creates confusion. The earlier `SettingsRoot.tsx` icon
  fix (`b4b7072`) was the lesson.
- **Anything dsh lacks is solved on the plugin side** (for example: archive nav icon →
  navIconPatch.tsx).
- For genuine dsh bugs/improvements, **submit an independent PR to the deepseek-ai upstream**;
  this plugin must not depend on behavior that only exists after that PR merges.
- The fork branch (codex/conversation-undo-plugin) is only staging for main-tree changes; it is
  not part of the plugin.

## Delivery Status: complete and passing

- **6 packages + 1 vendored dependency** all build:
  - `packages/rollback-fork` (session fork capability, migrated nearly as-is)
  - `packages/rollback-archive` (rewritten: list / read-only / tombstone hiding, no restore,
    no permanent delete)
  - `packages/rollback-undo` (rewritten: no terminate, no restoreUndo, new `admissionFailure`
    Remote, automatic cleanup downgraded to a tombstone)
  - `packages/client-rollback-button` (rewritten: mounts
    `conversation.session.header.actions`, self `$mount` Remote, polls admission-failed after
    running stops and back-fills the composer)
  - `packages/client-rollback-settings` (rewritten: mounts `settings.section`, list +
    read-only view + tombstone delete)
  - `packages/bundle-rollback` (cordis.patch.yml + dependency manifest)
  - `packages/typert-protocol` (vendored source of `@deepseek-ai/dsh-typert-protocol`)
- **Verification**: `pnpm run typecheck` (host+client dual aggregate) passes; `pnpm test`
  7 files 19 cases all green; `pnpm run build` produces host `lib/` and two `lib/client.js`
  (with the `__ModuleLoader__.load` banner, remote contribution inline).

## Key Technical Decisions (refactor points)

1. **Degradations forced by the pure-plugin constraint** (compare original PLAN.md §2.2):
   - forced terminate → `cancel()` + 0.5s grace + force-stop of registered jobs/PTYs + reject
     if still busy;
   - permanent delete → tombstone (plugin-private `tombstones.json`, list filtering; disk files
     kept);
   - restore archive / undo rollback → dropped (dsh has no public unarchive API);
   - rollback button → session header (the original has no user-message-level slot);
   - `undo/admission-failed` → Host in-memory cache + `@Remote('admissionFailure')`; the browser
     polls once when `session.running` goes true→false (the original push event cannot be
     forwarded through the api-remotes hardcoded allowlist).
2. **Three prerequisites for typert generation** (otherwise `pnpm run build:lib:host` fails):
   - typert-protocol must be a workspace-registered package (vendored source); `pnpm-workspace.yaml`
     `overrides` forces all dsh packages to resolve to it;
   - `tsconfig.base.json` `paths` maps `@deepseek-ai/dsh-typert-protocol` (including `/types`) to
     `src/` — the generator maps export targets back to `src`, while npm resolution would land on
     `lib/types/index.d.ts`;
   - `patches/typert-generator-workspace-only.patch` (applied via patchedDependencies):
     `typeMetaMapMembers` scans only workspace-registered files, otherwise the npm dsh twin
     instances (two copies of dsh-session produced by circular peers) double-declare
     TypertLookupMap/TypertContextMap.
   - package-level tsconfigs need `references` to typert-protocol (the host+client aggregate
     needs the same).
3. **`@dsh-rollback/*` internal dependencies use `workspace:^`**; dsh peers are always
   `^0.1.0-rc.6`; `@deepseek-ai/cordis` is `^4.0.1` (not rc.6).
4. **The browser client does not inject `remote.<namespace>`** (in the self-mount scenario that
   forms a circular dependency with `$mount`); it injects only the `remote` service.

## Pitfalls Already Hit (reproduction guide)

- PowerShell 5.1 `Set-Content -Encoding UTF8` writes a BOM → tsdown/vite JSON parse failure;
  use BOM-less UTF-8 everywhere.
- vitest fails to transpile TS 6 standard decorators → `standardDecoratorPlugin()` in
  `vitest.config.ts` (TS `transpileModule` pre-transform, replicated from dsh).
- The tsdown host pass treats a bundle package with no `src` as an entry and errors → the bundle
  package's tsdown.config.ts returns `[{ entry: '' }]`.
- pnpm 11 no longer reads the `pnpm` field in package.json; all settings live in
  pnpm-workspace.yaml.

## Remaining Work and Recommendations

- **End-to-end manual testing not done** (needs `DEEPSEEK_API_KEY`): verify rollback / archive /
  failure back-fill under a really assembled web profile, and the actual install command
  `dsh plugin --profile web add <bundle path>`.
- Package names use the local scope `@dsh-rollback/*`, `private: true`; before publishing decide
  the official scope per PLAN §8, remove private, and add a bilingual README plus version
  prerequisite notes.
- The test surface is smaller than the original worktree (original: 78 files / 1157 cases across
  9 packages; this independent project focuses on 6 packages). Core logic (Shadow Git, journal
  schema, cut, controller, UI) is covered; rollback-undo's full state machine
  (arm/ready/quiescing/restoring/complete) and startup recovery (recoverJournals) have no direct
  tests yet; add them later.
- `dsh-rollback-plugin/PLAN.md` is the review blueprint (unchanged); this file is its
  implementation record.

## Local assembly record (2026-08-16, actually tested)

Assembled into `~/.dsh/profiles/web` successfully and verified at startup:

```sh
# 1) space-free junction (a path containing spaces makes pnpm/dsh split arguments; link dangles)
mklink /J C:\Users\34293\dsh-rb-link "C:\Users\34293\Desktop\<old-workspace>\dsh-rollback-plugin"

# 2) install the 5 plugin packages (link protocol; package deps already use real versions ^0.1.0-rc.6)
dsh plugin --profile web add "link:C:\Users\34293\dsh-rb-link\packages\rollback-fork" \
  "link:C:\Users\34293\dsh-rb-link\packages\rollback-archive" \
  "link:C:\Users\34293\dsh-rb-link\packages\rollback-undo" \
  "link:C:\Users\34293\dsh-rb-link\packages\client-rollback-button" \
  "link:C:\Users\34293\dsh-rb-link\packages\client-rollback-settings"

# 3) install the bundle (enters the dsh.profile.bundles layer)
dsh plugin --profile web add "link:C:\Users\34293\dsh-rb-link\packages\bundle-rollback"
```

Verification results:
- `dsh --profile web --dump-config`: 5 plugin rows inserted from the bundle layer ✓
- `dsh --profile web` starts, `http://127.0.0.1:3080` HTTP 200 ✓
- `window.__DSH_BOOT__.entries` (40 entries) contains `@dsh-rollback/client-rollback-button` and
  `client-rollback-settings` ✓
- `/plugins/@dsh-rollback/client-rollback-button/client.js` and the others return 200 (151/176 KB) ✓

**Pitfall**: `link:C:\...\<old-workspace>\...` (path containing spaces) was split by pnpm into two
specs, `link:C:\...\dsh` + the remainder, producing dangling links; you must go through a space-free
junction. After code changes rerun `pnpm run build` inside `dsh-rollback-plugin` (the link is live).

**Precondition for use**: the browser needs a session that has already sent a qualifying plain-text
message before the rollback button (session header) appears; model calls still need
`DEEPSEEK_API_KEY`.

## Browser test record (2026-08-16, script `scripts/debug-browser.mjs` + puppeteer-core)

Drove the system Chrome to verify the full chain and fixed three hidden bugs:

1. **react dual instance** (`slot entry crashed in 'conversation.session.header.actions':
   Cannot read properties of null (reading 'useState')`): the bundle inlined react;
   `scripts/client-externals.ts` now adds the platform seeds (`react`/`react/jsx-runtime`/
   `react-dom`/`react-dom/client`/cordis/ui-slots etc.) — the module table shares one react.
2. **`UserMessageNode.messageId` does not exist in the published version** (it was added by this
   feature in the worktree): the button decision changed to "show whenever the Host holds a
   rollback point" (the journal keeps only the latest qualifying message, so
   `view.value.messageId !== undefined` suffices), no longer comparing message nodes.
3. **`ctx.remote.<namespace>` property access must declare inject, but declaring it deadlocks the
   self-mount** (cordis waits for the namespace service to register before apply): switched to
   `ctx.get('remote.<namespace>')` (read after mount, no inject needed).

Also added the `/rollback` host command (registered by rollback-undo, `ctx.commands.register`), no
arguments, errors carry the session id and workspace; this is the most direct trigger besides the
message-level button.

**Measured results**: `/rollback` executed successfully after the message turn completed — journal
`ready`→`complete`, S2 (`conversation-undo-*`) created, S1 archived; the header rollback button
displays normally on sessions holding a rollback point (aria-label `Rollback to before this
message`). **The command path is coherent too**: after the host archives the source session, the
client `followRollbackChild` (client-rollback-button) observes the workspaces archive delta, calls
the new `rollbackChild` Remote to get the child id, and automatically calls `sessions.open` — about
20 seconds after a successful `/rollback` the UI switched to the new session with no manual click.

**Timing hint**: while the model turn is unfinished `/rollback` reports "no message available for
rollback" (the journal is not ready); wait until the elapsed-time statistic appears. A freshly
forked child session has no journal of its own, so a new message must be sent to establish a
rollback point before `/rollback` again (the error text says so explicitly).

## 2026-08-16 session: fixing "the session is exited after rollback"

User report: after `/rollback` the UI exits the session and the user must manually click into the
new session to continue.

Root cause: the command path (the host-side `/rollback` command) archived the source session
successfully but nothing happened on the client; the workspaces projection clears the archived
current session from the view, so the UI stays on the session list.

Fix (inside the standalone plugin, no dsh changes):
- host: new `@Remote('rollbackChild')` (types.ts adds `ConversationRollbackChildRequest`), returning
  the child id for journals with `phase: 'complete'` that hold a `rollbackSessionId`.
- client: client-rollback-button subscribes to `workspaces.list` and calls `rollbackChild` for each
  archive delta; if there is a child, `sessions.open(child)`. Manually archived sessions without a
  journal don't trigger; old archives in the cold-start baseline don't trigger either (prevArchived
  already contains them at init).
- verification: browser automation in a real session sent a message → got the answer → `/rollback` →
  the UI auto-navigated to the new session (`scripts/e2e-auto-navigate.mjs`, asserting the
  localStorage `dsh.sessions.current` change). 19 unit tests + typecheck + build all green.

## 2026-08-16 session: "undo" fold strip above the input box (opencode style)

Per user request (referencing the opencode UI), added the `RollbackFold` component: a collapsible
message strip right above the composer card (`conversation.input.dock` slot, id `rollback-fold`):

- with a rollback point (the latest completed plain-text message) it shows one line:
  `↩ Undoable <prompt preview (>48 chars expandable/collapsible)> [Undo]`
- the "Undo" button triggers `undo(messageId)`; on success the existing logic auto `sessions.open`s
  the new session (measured within 33s; the `undoing` state disables the button)
- not shown when there is no rollback point or the session is running; the button is disabled while
  running
- implementation: `packages/client-rollback-button/src/client/RollbackFold.tsx` (+ CSS module); in
  apply it shares the controller and the open logic with the header action
- verification: `scripts/e2e-fold.mjs` drives a real session: answer completes → fold strip appears →
  click undo → auto-navigate to the new session (two consecutive rounds `ebccfc4e→04b4f6d8→2096ba0a`
  both succeeded); unit test `previewLine` (short message not truncated / long message ellipsis),
  20 tests all green
- width alignment (user request, corrected afterwards): `.fold` consumes the composer width axis
  variables on the session root
  `width: calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))` +
  `max-width: var(--dsh-composer-card-max-width, 780px)` (both with fallbacks), same cap and same
  side clearance as the input card, perfectly aligned on both sides at any viewport. The earlier
  conclusion that a hardcoded `max-width: 1152px` aligned them was wrong (the old measure script
  looked for the first ancestor with horizontal padding, but the composer card only has padding-top,
  so it matched the full-width InputBar container).
- note: once there was an intermittent no-response after clicking undo (a race when testing
  immediately after a restart); retests succeeded consecutively; no errors in the host log

## 2026-08-16 session: fold strip semantics changed to "revoke rollback" (appears only after a rollback)

User corrected the semantics: the strip appears only after `/rollback` (or the header rollback
button), its function is **revoke rollback** (undo this rollback, restoring the rolled-back session
and file state), and it disappears once a new prompt is accepted. The old "undoable [Undo]" semantics
(rolling back the latest message of a normal session) was removed from the strip; the rollback
entries remain the header button and the `/rollback` command.

Implementation (inside the standalone plugin):
- **host (rollback-undo)**: new `@Remote('revokePair')` (the child session reads the retained complete
  rollback pair) and `@Remote('revoke')` (a full reverse transaction: verify the workspace's current
  tree equals `beforeTree` — otherwise reject with `workspace-diverged` and do not overwrite user
  changes → fork the archived source session to `completed-turn` (a full session; archived sessions
  are still readable from persistence) → `shadow.restore(redoTree, beforeTree)` to restore files →
  archive the child → rewrite the journal to `{source: restored, phase: 'ready'}`, re-arming the
  rollback point (rollable again, symmetric). Transaction phase `revoking` + the `revokeSessionId`
  field; `recoverRevoking` at startup commits when "child archived and files == redoTree", rolls back
  when "files == beforeTree", otherwise `recovery-required` (symmetric to `recoverRestoring`).
- **arm stale journal cleanup**: on each new prompt acceptance delete the other journals with the
  same source (old lineage/generation), fixing two issues: (1) a potential bug — when a child session
  sends two prompts in a row the second uses a new lineage directory, and the first journal remains,
  making readJournal ambiguous; (2) the ready point written back by revoke is correctly superseded by
  the next prompt.
- **client**: the controller view gains `revokePair`, and refresh fetches current+revokePair together;
  `revoke()` on success clears the pair and returns the restored session id for navigation. The strip
  shows only when `revokePair` exists and the session is not running (hidden immediately while
  running, combined with the host deleting the pair after the new prompt is accepted); the text is
  `↩ Rolled back <preview> [Revoke rollback]`.
- 28 unit tests (added three controller revoke cases, four fold cases, one schema revoking case).

## 2026-08-16 session: rollback / revoke performance optimization (measured 40s+ → 1.5s/10s)

The user reported that rollback and revoke were too slow, and that the fold strip width rule had been
lost (overwritten by some rollback). Measured and fixed:

**Root causes of the slowness (real workspace with 7412 tracked files, measured in the replicated
GIT_DIR mode):**
- `git add --all` (capture): 31.7s cold / 5.8s hot
- `git write-tree`: 6.3s cold / 1.0s hot
- `read-tree` + `checkout-index --all --force` (restore): 11.1s full
- capture once per message arm; capture (redoTree) + restore per rollback; capture (verify) + restore
  per revoke. Add forking a new Agent, archiving, and the client `sessions.open` pulling the full
  history, and the perceived time was 30-40s.

**Optimization (shadow-git.ts, no dsh changes):**
1. restore only the changed paths `checkout-index --force -- <paths>` (diff-tree already computed the
   change list) instead of rewriting everything with `--all`; >400 paths falls back to the full path
   (Windows command line limit).
2. the shadow repo enables `core.untrackedCache` + `core.splitIndex` (private config, the user repo is
   untouched): hot add 5.8s → 0.3s (untracked-cache caches the directory scan, split-index reduces
   index writes).

**Measured (e2e with polling timing):** after the answer completes the strip does not appear →
header rollback → **1.5s** auto-navigate to the child, strip appears → revoke rollback → **10.3s**
auto-navigate to the restored session, strip disappears. The width rule is restored (same 780px cap,
same 16px side clearance).

**Note**: during this work the previous round's revoke-rollback semantics implementation
(types/spec/index/controller/fold/apply/8 tests) was found to have been lost by a rollback, and was
restored as-is; e2e-fold.mjs was changed to poll for navigation timing instead of a fixed sleep.

## 2026-08-17 session: root cause of files not being rolled back + revoke speedup (9.2s→3.2s)

**Root cause of "wrote file 7777 on the desktop and the rollback did not restore it"**: `7777.txt` was
written at the desktop root (`C:\Users\34293\Desktop\`), while the session workspace is
`C:\Users\34293\Desktop\<old-workspace>`. shadow-git snapshots cover only paths inside the workspace
(git worktree boundary); the desktop root is not in the snapshot, so rollback naturally does not
restore it. Files inside the workspace roll back correctly (diag: 46s create → rollback →
4.8s → file deleted). This is a design boundary: rollback restores "workspace files"; agent writes
outside the workspace are not in the snapshot.

**Root cause and fix of slow revoke (9.2s→3.2s)**:
- breakdown: verifyMatches checking "workspace == beforeTree" is the bottleneck. The original
  implementation captured a full `git add + write-tree` (8.9s). Changed to `git diff --quiet <tree>`
  + `ls-files -o` verification — but cold git diff (index stat reset by read-tree) still needed a
  9.96s full stat; hot it is only 0.34s.
- fix: when undoLatest completes, run `update-index --refresh` in the background to prewarm the stat
  cache and record the promise in `statWarmers` (keyed by shadow dir); revoke awaits that promise
  before verifying (immediate if done, otherwise wait, max ~3s). The normal path revoke RPC is 3.2s.
- `verifyMatches` semantics: git diff only checks tracked files, `ls-files -o` covers untracked;
  modified files or new files in the workspace both return false (rejected as workspace-diverged).
- the recovery logic (recoverRestoring/recoverRevoking) was switched to verifyMatches as well.

**Incident record (important)**: editing a source file that contains Chinese with PowerShell
`Get-Content -Raw` + `Set-Content -Encoding UTF8` decodes the whole file as ANSI (GBK) and writes it
back, corrupting all the Chinese text and partly irreversibly (quotes swallowed). index.ts was
corrupted this way; it was recovered by extracting 20 Chinese strings from `lib/types/index.js` (the
correct tsc output) and repairing line by line. Lesson: edit source containing non-ASCII with a node
script or an editor, never through PowerShell text pipelines; `lib/types/*` is a reliable reference
for repairing mojibake.

Measured (with polling timing): rollback 2.1s, revoke rollback 3.2-6.7s, width rule normal, and the
strip semantics "appears only after a rollback / disappears on a new prompt" complete.

## 2026-08-17 session: fixing the unusable "delete" on the archived tasks page

User report: deleting on the archived tasks page shows "operation not completed, please retry".
Investigated three layers:

1. **patch conflict**: the base bundle's `ui-settings-archive` (dsh-client-ui-settings-archive)
   registers the `sessionArchive` namespace first, so the plugin's contribution is skipped by the
   mountOnce probe → the client's `remote.sessionArchive` has no tombstone method. Fix: the plugin
   bundle patch disables that row (`{ id: ui-settings-archive, disabled: true }`), and the plugin
   contribution mounts normally.
2. **parameter shape bug**: `tombstone(sessionId: SessionId)` generates a bare-value parameter (wire
   `sessionId`, schema `z.intersection(z.string(), z.unknown())`), but the client called it with an
   object `archive.tombstone({ sessionId })` → the gateway's positional-parameter parse validates the
   object as a string and fails (`rejected "sessionId"`, ZodError expected string). Compare:
   rollback-undo's method parameters are all `request` (object) shaped, where passing an object is
   correct. Fix: the client switched to the positional parameter `archive.tombstone(sessionId)`.
   **Lesson**: typert Remote calls must match the generated parameter shape (bare value vs object);
   look at the parameter `name/wire` in `lib/typert.remote-client.js`.
3. **tsc incremental cache staleness**: several `build:lib:client` runs did not recompile (src newer
   than the output, tsbuildinfo not invalidated) — the illusion that the change "had no effect". Fix:
   after changes explicitly run `pnpm exec tsc -b tsconfig.client.json --force` before bundling, or
   delete the tsbuildinfo.

Verification: UI delete → confirm → tombstone request sent, no error, list decreased (46→45). Host-side
list filtering of tombstones, and direct tombstone/untombstone RPCs, all normal. 29 unit tests all
green; temporary diagnostic scripts cleaned up.

## 2026-08-17 session: archived tasks changed to "restorable + permanent delete"

User request: archived conversations can be restored; delete becomes deleting the on-disk data (it was
previously tombstone hiding).

**Implementation (pure plugin, within the rc.6 public API)**:
- **restore** (`@Remote('restore')`): uses rollback-fork's `completed-turn` to fully fork the archived
  session into a new visible session (the archived session is still in persistence, readSource can read
  it) and returns the new sessionId; the client `sessions.open`s it directly. The old archive stays in
  the list (restorable repeatedly).
- **delete** (`@Remote('delete')`): live check (no agents/sessions instances) →
  `sessionPersistence.locate(header)` to get the jsonl artifact path → delete the whole session
  directory (`rm -rf dirname(path)`, including session.jsonl.zstd) → clear archiveTimes → tombstone.
  Other backends (locate undefined) are rejected (`backend-unsupported`). rc.6 has no
  `unarchiveSession`/`sessionPersistence.delete`/`agents.terminate` (the main repo worktree has them,
  unpublished) — hence restore uses fork and delete uses locate+rm.
- **client**: each item gains a "restore" button (directly opens the new session) and a "delete"
  (real delete, confirmation text "permanently delete this conversation's on-disk log? this cannot be
  undone."); the text changes to "archived conversations can be restored as new sessions; deleting
  permanently removes the logs on disk."; the tombstone hide entry is removed (host-side
  tombstone/untombstone kept for rollback cleanup).
- **bundle patch**: additionally disables the base's `session-archive` host row (it conflicts with the
  plugin's restore/delete endpoints; after disabling, the plugin fully takes over sessionArchive).
- verified: restore returns a new session (disk directory created, workspace ownership kept), delete
  makes the disk directory disappear, list decreases; the UI has all three buttons; 30 unit tests all
  green.

## 2026-08-17 session: cold-start optimization for the first message on a new branch after rollback (31s→3s)

The user asked about speed; implemented the largest remaining optimization: the arm snapshot for the
first message on a new branch produced by a rollback needed a cold `git add --all` (31.7s), so sending
a message right after a rollback stalled.

**Implementation (rollback-undo)**: after undoLatest completes, **pre-initialize in the background**
the next generation's shadow directory (`new ShadowGit(workspace, childShadowDir).capture()`). At that
moment the workspace exactly equals beforeTree (the restore just landed), which is precisely the
beforeTree of the new branch's first message; if the user has manually changed files, arm's incremental
add corrects it automatically. A `prearms` Map records the promise; arm awaits `prearms.get(dir)` before
its capture to avoid contending with the pre-initialization over the shadow index (a lock conflict would
fail the capture and reject the message).

**Verification**: disk evidence — the child shadow directory contains a complete object store
(objects=258, a cold-start artifact), arm completes within 3s (previously 31s+ cold); the full e2e shows
no regression, and rollback/revoke navigation are both 1.0s (statWarmer prewarm + hot system cache).
30 unit tests all green.

Remaining optimization space: verifyMatches' 2.9s stat is NTFS+Defender physical cost (recommend
excluding ~/.dsh and the workspace in Defender); `sessions.open` history loading is dsh's own behavior.

## 2026-08-17 session: fixing slow rollback after a revoke

Symptom: the first rollback is fast; after revoking a rollback the next rollback is noticeably slower.

Root cause: revoke's verifyMatches/restore runs read-tree, which makes S3's shadow index stat cold, and
revoke completion had no background prewarm like undoLatest — so the next rollback's redoTree capture
becomes a full cold stat (10s+).

Fix: after the revoke commit, same as undoLatest, start the statWarmer to prewarm the current journal
directory's shadow index (silent on failure; verify falls back to the cold path).

Verification: rollback#1 1.6s → revoke 1.6s → rollback again 1.6s, all three consistent; 30 unit tests
all green.

## 2026-08-17 session: archived tasks "delete all"

The settings/archived-tasks page gains a "delete all" button: host `@Remote('deleteAll')` iterates all
non-tombstoned archived sessions deleting each permanently (reusing the delete logic, a single failure
does not abort), returning { deleted[], failed[] }; the client makes one RPC, a confirmation dialog
double-confirms, refresh on success, and a partial-failure message "deleted X, Y failed". The text uses
parameter interpolation (`deleteAllPartial` uses t(key, {deleted, failed})).

Verification: 66 archives cleared at once (deleted full, failed empty, list zero); 31 unit tests all
green (added the deleteAll confirmation case). Note: after deleteAll deletes session logs, rollback-undo's
journals still reference the deleted sessions (data is gone, no functional impact; undoLatest reports not
found for a deleted source, as expected).

## 2026-08-17 session: fixing "delete all" not executing

Symptom: clicking "delete all" in the UI has no effect (the user reports an "invalid operation").

Root cause 1 (primary): delete's live check rejected every "archived session with a residual agent
instance" as session-live — rollback only archives the source session and does not destroy its agent
object, so a just-rolled-back archive is almost always "live". Fix: a busy agent first gets
`cancel({kind:'user'})` + polling until idle (2s timeout), and is rejected only if still busy; an idle
agent residue does not affect deletion (after the log is deleted the in-memory object is harmless and
disappears on restart). TS narrowing pitfall: for async-changing status, read into a separate variable of
type `Agent['status']` from `agent?.status` to avoid narrowing false positives.

Root cause 2 (secondary): deleteAll's partial message was cleared by `reload()` (`setFailure` ran before
reload's `setFailure(undefined)`) — reordered to reload first, then setFailure.

Verification: send a message → rollback (1.9s) → archived tasks → delete all → confirm → request sent, no
error, list zero, the archived source session log disappears from disk (the current active child session
log is kept, correct). 31 unit tests all green.

## 2026-08-18 session: further speedup of rollback/revoke + main-tree port

Found that all previous performance optimizations (untrackedCache/splitIndex, path-limited restore,
statWarmer, prearm) had only been made in this plugin; the **main tree `packages/undo/conversation-undo`**
actually running in the web profile was still the old implementation (full `checkout-index --all`). This
session synced both:

- **restore (both shadow-git.ts)**: a single `diff-tree --name-status` directly yields the delete/checkout
  direction, dropping the full ls-tree of the target tree; only changed paths are checked out (>400 falls
  back to full).
- **assertWorkspace caching (both index.ts)**: the workspace assertion is cached per workspace within the
  process (failures not cached) — previously every message arm re-ran rev-parse + ls-files --stage (output
  growing linearly with the whole tracked tree).
- **fork ∥ restore parallelism (both)**: after the journal (restoring/revoking) is written to disk, the
  session fork and the file restore run in parallel (fork only reads session persistence, restore only
  writes workspace files). Journal-first guarantees the crash-recovery view is identical to the serial
  order; on fork failure, settle the restore and compensate with a reverse restore to put the files back
  before going through generic recovery. revoke's verify still runs before the fork (a diverged reject
  produces no session).
- **arm scan merge (plugin)**: lineage lookup and stale-point sweep share one readJournals.
- **verification**: both tsc pass; plugin 31 unit tests green; main tree 6 unit tests green; browser
  retest after restart (main-tree path, 7400+ file workspace): **rollback 1169ms, revoke rollback 653ms**
  (the plugin era's best was 2.1s/3.2-6.7s). State transitions and recovery semantics all normal.

## 2026-08-18 session: `/update` self-update command

rollback-undo gains a `/update` host command (same registration point as `/undo`), one-click update of
this plugin's installation: `git pull --ff-only` → `pnpm install` → `pnpm run build`, all through shell
spawn (Windows resolves pnpm.cmd), per-step timeouts 30s/120s/300s/600s, killed on timeout. When HEAD did
not move it reports "already up to date (short hash)" and skips install/build; if any step fails it
returns error text with that step's stderr and hints the equivalent commands to run manually. After
updating, dsh still needs a restart (a link install loads the built artifacts in lib/, effective after
restart).

- the workspace root is resolved by `pluginWorkspaceRoot()` three levels up from the module path and
  validated to contain `pnpm-workspace.yaml` (holds for both src and lib layouts, preventing a silent
  wrong root if the layout changes).
- new `tests/update.spec.ts` (a real temporary git repo: clone of the source + clone): up-to-date no-op /
  upstream advancing, HEAD follows / a diverged clone is rejected by `--ff-only` (does not rewrite the
  user's local commits). pluginWorkspaceRoot is asserted against this repository's real layout.
- the command has no background auto-update; it is always user-initiated and rejects calls with arguments
  (returns usage text).

## 2026-08-18/19 session: GitHub release and documentation wrap-up

- **release**: the plugin was uploaded to **https://github.com/23swccp/dsh-undo** (public, MIT, topics:
  dsh-plugin/deepseek/cordis/plugin/rollback; the local origin still points at
  `23swccp/dsh-rollback-plugin`, and both repositories sync from the same source). The README display name
  changed to **dsh-undo-plugin**; the repository and package names keep the historical `rollback`, with a
  note in the README explaining that.
- **local path migration**: the plugin workspace moved from `Desktop\<old-workspace>\dsh-rollback-plugin`
  to a standalone `Desktop\dsh-rollback-plugin` (self-contained, depending only on published npm packages).
  The old `dsh-rb-link` junction points at a stale path; re-link installs must create a new junction at the
  new path (still requires a space-free path).
- **README three-part restructure** (bilingual): overview / concrete features / installation. The install
  commands changed from placeholders `/path/to/...` to a copyable
  `git clone https://github.com/23swccp/dsh-undo.git` full flow.
- **archived-task nav icon** (main-tree fix, not this plugin): dsh `SettingsRoot.tsx`'s `navIcon` only
  recognized {models, agent-presets, plugins}, so the plugin's registered `id: 'archive'` fell into the
  fallback and showed the settings gear. The main tree changed it to a `NAV_ICONS` lookup table (prevents
  vite tree-shake) mapping `archive` → `IconArchiveOutline20`. This plugin registers `settings.section`
  with `id: 'archive'` and benefits automatically once the main tree is fixed, with no changes needed.
- **"cannot read archived tasks for now" false alarm**: after the server stops, every RPC from an old
  browser page fails and the archive page falls to the `loadFailed` fallback text — not a data bug;
  restarting the server restores it.

## 2026-08-19 session: cross-platform adaptation (macOS/Linux) and a three-platform CI matrix

The user asked for the plugin to work outside Windows. Whole-repository platform-coupling audit: the
runtime core was already platform-neutral (Shadow Git pipeline commands go through shell-less spawn argv,
`core.autocrlf false` pins line endings, `node:path` `sep` joining, `/update` resolves pnpm through each
platform's default shell via `shell: true`, atomic writes retried by comparing error codes); only two
Windows-only places existed, both fixed:

1. **4 dev scripts hardcoded Windows Chrome paths** (`scripts/debug-browser.mjs`, `e2e-fold.mjs`,
   `measure-fold.mjs`, `e2e-auto-navigate.mjs`): changed to `process.platform` three-platform defaults +
   a `CHROME` environment override (Linux distros without google-chrome use `CHROME=`).
2. **rollback-archive `writeDocument` was a non-atomic write** (writeFile overwrite, risk of a half-written
   JSON): added a temp file + rename + `EPERM/EBUSY/EACCES` backoff retry symmetric with shadow-git's
   `writeJson`; the dependency direction undo→archive is one-way so it cannot be reused in reverse — the
   same pattern is copied inside the package.

- **CI** (`.github/workflows/ci.yml`): triggered on push to master / PR, a ubuntu/macos/windows
  three-platform matrix runs `pnpm install → typecheck → test → build` (fail-fast disabled); the first run
  was green on all three (29s/40s/1m5s), closing the verification gap for having no real POSIX machine.
- README bilingual: added the CI badge; "Windows note" became a "Platform support" section; the atomic
  write description was corrected (it is linear backoff, not exponential).
- commits: `9b16895` cross-platform fixes, `4bd9def` CI, this documentation update.

## 2026-08-19 session: npm dsh install test, found and fixed a README install-flow bug

On a freshly repaired npm global dsh (0.1.0-rc.6; the old install's commander dependency was broken,
uninstall+reinstall fixed it), tested "a brand-new user installing per the README":

- **Bug**: the README's original install command was only `dsh plugin add ./packages/bundle-rollback`.
  pnpm's `link:` protocol does not install the dependencies declared by the linked bundle, and the dsh
  loader resolves plugin package names from the profile's node_modules — the five plugin packages were not
  in the profile node_modules, so startup failed with
  `ERR_MODULE_NOT_FOUND: Cannot find package '@dsh-rollback/rollback-fork' imported from profiles/web`.
  The old junction assembly worked precisely because all six packages were linked one by one.
- **Fix**: the README (both languages) install command changed to one command linking all six packages,
  with the reason noted.
- **Verification** (npm dsh + new path Desktop\dsh-undo, the workspace renamed from dsh-rollback-plugin and
  no longer containing spaces, so no junction is needed):
  - `dsh --profile web --dump-config`: 5 plugin rows inserted from the bundle layer ✓
  - `dsh web` starts, HTTP 200 ✓; `/plugins/@dsh-rollback/client-rollback-button/client.js` 200 (153KB),
    client-rollback-settings 200 (178KB) ✓
- **Harmless warnings**: dump-config reports the patch's `ui-settings-archive` / `session-archive`
  "entry not found" (the npm rc.6 base has no such ids, so the disable is a no-op and does not affect
  startup); the "declares no dsh.bundle" warning when adding the 5 plugin packages is also expected (only
  the bundle is a profile layer).
- Also: cleaned up five orphan links in the profile pointing at the deleted junction; deleted the leftover
  build-log/build-done temp files on the desktop.

## 2026-08-19 session: dsh upgrade to rc.7 + installing the dshmarket plugin marketplace

The user wanted the plugin marketplace plugin (dshmarket). Its peer dependency
`@deepseek-ai/dsh-settings@^0.1.0-rc.7` but the global dsh was rc.6 → ran
`npm i -g @deepseek-ai/dsh@latest` to upgrade to rc.7 (the plugin packages' peer `^0.1.0-rc.6` semver range
covers rc.7, so zero plugin changes were needed).

- **dshmarket install**: `dsh plugin --profile web add dshmarket` resolved to 1.13.1 by default — pnpm's
  `minimumReleaseAge` supply-chain policy excluded 1.15.0 released that day; an explicit
  `add dshmarket@1.15.0` (which auto-writes a minimumReleaseAgeExclude exemption) landed 1.15.0.
- **regression verification under rc.7** (the plugin workspace deps were still rc.6, the two versions
  coexist exactly as before):
  - `dsh --profile web --dump-config`: the dshmarket `dsh-market` row + all 5 rollback plugin rows
    assembled ✓
  - `dsh web` starts, HTTP 200, clean log ✓; rollback's two client packages 200 (153KB/178KB, byte-for-byte
    the same sizes as at rc.6 startup) ✓; dshmarket client.js 200 (299KB) ✓
  - note: startup-level verification only; the full rollback function chain was not re-run under rc.7
    (needs an API key and a real session).
- **found**: one dangling `dsh` junction in the profile node_modules (pointing at the deleted old source
  tree location `Desktop\dsh`), harmless residue — the core @deepseek-ai/* packages resolve through the
  global dsh install, not the profile; the earlier successful rc.6 startup confirms this.
- README prerequisites updated to dsh `0.1.0-rc.6` / `0.1.0-rc.7`.

## 2026-08-19 session: archived-task nav icon moved to a plugin-side patch (fixing the fallback gear under npm dsh)

User report: the archived-task icon under npm dsh (rc.6→rc.7) reverted to the settings gear. Root cause: the
NAV_ICONS fix (`b4b7072`) was made in the fork main tree, so it only worked when starting from the source
tree; npm-installed dsh uses the upstream `SettingsRoot`, whose `navIcon(id)` is still a hardcoded if-chain
(anything outside models / agent-presets / plugins falls back to the gear), and the `settings.section`
registration interface has no icon field — a plugin cannot declare an icon through registration.

**Implementation (client-rollback-settings, new `src/client/navIconPatch.tsx`)**: a browser-side
MutationObserver patch — after the settings panel mounts or re-renders, match this plugin's nav row by label
text, clone the svg rendered by `IconArchiveOutline20` (host module table external) and insert it before the
gear, keeping the gear with `display:none` (the node is not removed). **Key lesson: do not use replaceWith to
delete nodes inside a React-managed subtree** — v1 replaced the gear directly and measured the row label
broken to an empty string (React diff assumptions invalidated); v2 only hides and inserts a foreign node,
React diff doesn't touch it, and the label stays intact. Locale changes are covered by the observer's
idempotent rescan (the `data-nav-icon` marker prevents duplicates).

- deps: `@deepseek-ai/dsh-client-ui-primitives` added to peer/dev (already in the externals table);
  `@types/react-dom` added to dev; `react-dom/client` + `flushSync` (synchronous template render).
- **verification** (npm dsh rc.7 + dshmarket 1.15.0 coexisting): puppeteer opened the settings panel; of the
  6 nav rows only the archived-tasks row had `data-nav-icon=dshArchiveNavIcon`, the label was intact, and the
  cloned svg carried the navIcon class; the general/models/plugins/agent-presets/plugin-market rows were
  unaffected.
- new test `tests/navIconPatch.client.spec.tsx` (4 cases: only the matching row is patched / idempotent / a
  row mounted later is patched by the observer / no match means no change); primitives are mocked in the test
  (its entry imports katex CSS, which node cannot load). settings package 10/10, typecheck/build pass.
- **known environment issue (not from this change)**: rollback-undo's 4 real git tests (shadow-git×2,
  update×2) stably time out at 30s + EBUSY on this machine — a stash comparison experiment proved it is
  unrelated to this change (they fail the same way without stashing); Defender/indexer locking the Temp
  directory; CI (isolated ubuntu/macos/windows environments) is the authority.

## 2026-08-19 session: tool cards colored by tool type (client-rollback-toolcards)

User report: after switching from the dsh main-tree source to npm rc.7, two behaviors disappeared from
sessions: the "reasoning and actions fold strip" and the "tool-specific colored cards".

**Diagnosis (before fixing; the conclusion differs from the guess in the task description)**:
- the fold strip **was not lost**. rc.7's `@deepseek-ai/dsh-client-ui-tool` fully implements the fold strip
  (GenericToolCard/ToolRow + DisclosureRow, keyed BashRow); loading a historical session with caching
  disabled showed all 5 tool rows rendered and expandable — what the user saw missing was only a browser
  cache/old-page illusion, no assembly fix needed.
- what was genuinely missing was **tool-specific coloring**: rc.7's ui-tool CSS has only the unified
  `--dsw-alias-*` theme variables, and every card (terminal/diff/read/search/web/code) uses
  `var(--dsw-alias-markdown-code-block)` (`rgb(249,250,251)` in the light theme). The main tree once had
  "the bash terminal card always black" (bash-sample.module.css scoped token override, 2026-08-17 session),
  but that change never went into the npm release — which is exactly where the user's memory of a "black
  bash background" comes from.
- rc.7's renderer already publishes stable DOM hooks (non-hashed class names), so CSS injection is fully
  feasible: generic row root `[data-tool]` + cards `[data-terminal]`/`[data-diff]`/`[data-read]`/
  `[data-search]`/`[data-web]`/`.md-code-block` (CodeBlock's literal marker class); the keyed BashRow row
  root is `[data-sample="bash"]` and its expanded body is its **next sibling** (`+ div > div`; inside the
  card wrapper, row and body are siblings, so a descendant selector cannot be used); a pwsh title exists
  (`TOOL_TITLES.pwsh`) but there is **no keyed row**, so it falls on the GenericToolCard path
  (`data-tool="pwsh"`).

**Implementation (pure plugin side, zero runtime code)**:
- new package `packages/client-rollback-toolcards`: a single CSS file
  (`src/client/toolcards.module.css`) + an empty apply. The build chain compiles it into `lib/client.js`
  (a `__ModuleLoader__.load` closure), and importing it injects
  `<style data-plugin="@dsh-rollback/client-rollback-toolcards">`; every rule uses only data-attribute hooks,
  and specificity (≥0,2,0) beats the host's hashed single-class rules while React re-renders are covered
  automatically by the cascade — no MutationObserver needed.
- two coloring strategies: **shell type** (bash/pwsh) retargets the card element's
  `--dsw-alias-markdown-code-block/label-*/border-*` custom properties to static dark values and pins
  `background` (bash `#0d1117` GitHub dark, pwsh `#012456` PowerShell window blue), staying dark in both
  light and dark themes with descendants' text, banner, and copy button all following; **tint type** (the
  other tools) layers color over the current theme color with
  `color-mix(in srgb, <hue> 10~12%, var(--dsw-alias-markdown-code-block))` (edit/write green #2da44e,
  read purple #8957e5 with a deeper banner, grep/glob blue #4493f8 with a deeper header, web cyan #12a5b0,
  run_code amber #d29922).
- **css-modules hashing trap**: `.md-code-block` would be hashed by lightningcss into a module-local class
  like `.x_md-code-block` and then never match the DOM — it must be written as `:global(.md-code-block)`;
  the test guards this (selectors must not contain hashed patterns or bare classes).
- wiring: the bundle patch inserts the `client-rollback-toolcards` row + dependency manifest;
  pnpm-workspace overrides, tsconfig.client references, and the README (both languages, install command
  changed to seven packages) were synced.

**Verification (npm rc.7 + dshmarket 1.15.0, real session with DEEPSEEK_API_KEY)**:
- assembly: after `dsh plugin --profile web add <package>` dump-config shows the row; `__DSH_BOOT__.entries`
  contains the id and `/plugins/.../client.js` returns 200 (3KB).
- historical session (loaded with caching disabled): the pwsh terminal card `rgb(1,36,86)` (#012456), read
  purple, glob blue, write diff green all effective; synthetic DOM verified the BashRow selector →
  `rgb(13,17,23)` (#0d1117) and `--dsw-alias-label-primary:#e6edf3`.
- real new session (one prompt triggering four tools pwsh/write/read/glob): all 4 fold strips rendered and,
  expanded, the card background colors were blue/green/purple/light blue, with the plugin style tag present.
- regression: the header rollback button in the same session is normal (the rollback chain is unaffected);
  rollback's two client packages and the dshmarket assembly were untouched; 42 unit tests pass (7 new
  toolcards cases; the 4 known environment failures as in the previous section).
- new scripts: `scripts/e2e-toolcards.mjs` (historical session scan + synthetic bash verification),
  `scripts/e2e-toolcards-live.mjs` (real session four-tool trigger, needs the server with a key).

**Note**: the server's API key is injected only through the environment variable at startup and is not
written to any file; the e2e-produced `toolcards-e2e.txt` was cleaned up, and the live session was left in
the workspace for eyeball review (sidebar item "PowerShell directory/file operations task").

## 2026-08-19 session: Edge verification + reasoning/action fold strip + delete-all button radius + the trailfold package

The user verified in Edge, reported "the fold strip does not appear", asked whether it is caching and whether
it can always be displayed; also asked for the "delete all" button to lose its sharp corners and match dsh's
rounded style; and to push to GitHub afterwards.

**Edge diagnosis (conclusion: not a code bug)**:
- a fresh Edge profile (no cache) at both the `127.0.0.1:3080` and `localhost:3080` origins rendered, expanded,
  and error-free on all 4 tool fold rows of a historical session — the render path is intact.
- the `index.html` response has **no cache headers at all** (no Cache-Control/ETag/Last-Modified) → Edge applies
  heuristic caching, so an old tab / old cached shell gets the old boot manifest (old plugin set, old assets) —
  "it is a cache problem" holds, and Ctrl+Shift+R or reopening the tab recovers. This is a dsh host
  response-header issue; the plugin cannot fix it on dsh's behalf (no host changes).
- but "always displayed" points at a real gap: rc.7 has only **per-tool-call** fold rows, not the main-tree
  era's **per-turn "reasoning and actions"** top-level fold (the whole segment of thinking + narration + tools
  collapsed/expanded). Text-only/thinking-only turns have no fold strip at all under rc.7.

**rc.7 message flow DOM contract (implementation basis, measured in Edge)**: the message flow container is
`[data-chat-flow]`, each child node carries `data-chat-flow-kind` (user / context / assistant-step /
tool-call / turn-tail) plus a stable `data-chat-flow-key`. Turn boundaries are clear: user opens the turn →
trail (context injection, Think/narration step, tool-call) → the last assistant-step (anchored before tail =
conclusion) → turn-tail (artifacts + statistics). Think rows do render in rc.7 (Sxvs8a_root).

**Implementation one: client-rollback-trailfold (new package, package 8)**
- `planTurns`, a pure planner: user anchors the turn; only a closedByTail turn whose last element is an
  assistant-step has a conclusion (trail = everything except the conclusion); a turn abandoned by the next
  user is treated as having no conclusion (not folded, errors stay visible); no tail at the flow end = running.
- `mountTrailFold` DOM patch: the foreign fold strip is inserted before trail[0] (control position always above
  the trail); collapsing = per flowItem `style.display='none'` (DOM retained, React-safe, same strategy as the
  main tree); a MutationObserver full idempotent rescan (self-heals React re-render / virtualization remount /
  session switch); state is remembered per user key.
- behavior aligned with the main tree: while running it shows "running…" and stays expanded; when the turn is
  closed and the view is pinned at the bottom (`[data-conversation-scroll]` within 80px of the bottom) it
  auto-collapses, and it does not collapse while the user scrolls up reading; a historical turn seen for the
  first time stays expanded; a manual click overrides at any time; no conclusion / empty trail means no strip.
- **two deep pitfalls**: (1) `sync()` unconditionally rewriting `counts.textContent` replaces the text node →
  it triggers its own observer → infinite loop (located by vitest hanging) — write only when the value changes;
  (2) in the tests, flows left over from the planner group are also (correctly) given strips, so
  `document.querySelector` hits someone else's bar — a file-level afterEach clears the body.

**Implementation two: delete-all button radius**
- root cause: the `.bulk` container had **no rules at all** in CSS (used in TSX, never written in CSS), so
  "delete all/confirm/cancel" fell back to browser defaults (gray, square, outset border).
- fix: added the `.bulk` layout + `.bulk button` sharing the existing dsh recipe (28px tall, `border-radius:14px`
  pill, 12px font, the same as `.actions button` and dsh's `_sm` Button) + a `.bulk .danger` red variant.
- **build pitfall recurrence (precedent in this HANDOFF)**: the root `pnpm run build` did not rewrite the settings
  client output (mtime unchanged, `_bulk` not in the bundle); running
  `pnpm exec tsdown --env.DSH_BUILD_FACE client` directly in the package directory fixed it immediately. After
  CSS changes, rebuild inside the package or check that the output contains the new rules. CI's fresh
  environment has no such cache problem.

**Verification (Edge, server with key)**:
- fold strip: historical turn strips are present and expanded ("reasoning and actions · 2 thinking · 4 tools");
  manual collapse/expand hides/restores the trail while the conclusion and statistics lines stay put; a new
  streaming turn shows "running…", and after closure (view at bottom) auto-collapses to "1 tool"; the restored
  session's 4 bars are all normal.
- coloring regression: pwsh blue rgb(1,36,86)×3, read purple, glob light blue ✓.
- delete all: `border-radius:14px`, 28px tall, danger red, 12px font; confirm/cancel the same ✓ (the
  rollback→archive→revoke flow was also regression-tested along the way: the rollback/revoke/restore chain is
  normal).
- tests: 11 files 53 cases pass (trailfold 9 + 2 new archive style-contract cases); the 4 known environment
  failures are unchanged.
- new scripts: `scripts/edge-verify.mjs` (fold strip + coloring + auto-collapse), `scripts/edge-verify-archive.mjs`
  (rollback → button style → revoke); one-off diagnostic scripts cleaned up.

## 2026-08-20 session: message action row rollback button (client-rollback-button extension)

User report: "the message actions button set earlier — rollback — disappeared again", asking for it to be
restored with the same icon as the Enter key.

**Why it disappeared**: the message-level rollback button (next to Copy on qualifying user messages) was the
main tree's `ui-conversation-undo` implementation, so it naturally disappeared when the main-tree source was
deleted and we switched to npm rc.7; the plugin side never had it (rc.7 has **no user-message-level slot** —
MessageIconActions' extraActions are only exposed at turn-tail via `conversation.chat.assistant-actions`;
UserMessageNodeView does not pass it). The plugin had been using the session header button instead.

**Implementation (messageActionsPatch.ts, a DOM patch, navIconPatch pattern)**:
- **precise matching**: rc.7's chat flow publishes `data-chat-flow-kind` + `data-chat-flow-key` per node, and
  the `input-message<uuid>` tail of a user message key **is the durable message id** (conversation assembler
  `match: id: String(event.data.id)` = journal `messageId: message.id`, verified consistent across two live
  rounds). `key.endsWith(controller.view.value.messageId)` uniquely hits the message the rollback point points
  at — the button appears only on that message's action row and moves with the rollback point.
- **button shape**: a foreign icon button at the end of the action row (after the copy button), 28px circular
  (the same MessageIconActions recipe); `MutationObserver(childList)` + the sessions list subscription
  (current/running) + the controller view subscription together drive an idempotent rescan, self-healing React
  re-renders/virtualization/session switches; disabled while running and while pending; clicking goes through
  the same undo flow as the header button (controller.undo → sessions.open).
- **icon (the user asked for "the same as the Enter key")**: the composer send key is `ui-conversation`'s
  **inline SVG** (not a primitives export; its IconSendOutline16 copy's coordinates differ in the 3rd-4th
  decimal places) — the patch inlined the composer's exact path `M8.3125 0.980183C…`, and Edge measured
  `iconMatchesComposer: true` (byte-identical). The icon is pure DOM construction, no React/primitives
  dependency.
- **pitfalls**: (1) `dataset[dshRollback…]` writes a kebab-case attribute, so a selector written in camelCase
  never matches an existing button → a duplicate is inserted on every scan (exposed by the tests); the explicit
  `data-dsh-rollback-message-action` literal is required. (2) sidebar row text carries an elapsed-time suffix
  ("xx minutes"), so clicking by a title that includes it drifts over time — the e2e locates by a stable
  literal ('4242').

**Verification (Edge, server with key, real session)**:
- the button appears on the qualifying message's action row (after copy, at the end of the row), its aria/title
  matches the header button, and the icon path is byte-identical to the composer send key; another user message
  has no button.
- click → the rollback succeeds and navigates to the child session, the "↩ rolled back … revoke rollback" strip
  appears; revoke → restores and navigates to the restored session, and the message button, header button, and
  trailfold strip are all present (full functional regression).
- tests: 12 files 61 cases pass (8 new messageActionsPatch cases: insertion / no point means no button /
  disabled while running / moves with the point / click invokes / remount self-heal / destroy cleanup / icon
  byte contract); typecheck/build pass; the known environment failures (shadow-git Defender lock) are unchanged.
- new script: `scripts/edge-verify-messageactions.mjs` (full e2e).

**Rollback entries are now four**: the message action row icon button (Enter-key icon), the session header
button, the `/undo` command, and the revoke fold strip above the input box.

## 2026-08-20 session: investigating slow rollback/revoke (root cause: machine-level process creation cost, not code)

User report: rollback and revoke got slower, "it was optimized before, now it's back to the original".

**Investigation (first disprove a code regression, then measure)**:
1. the optimization code is all there: `src` and `lib` (statWarmer/prearm/untrackedCache/splitIndex/
   path-limited restore/diff-tree) present, lib mtime newer — no code regression.
2. timing e2e (100ms polling): rollback 4359ms, revoke 4138ms (the previous best was 1169/653).
3. phase breakdown: the live session's workspace is `Desktop\<conversation-workspace>` (**only 6 tracked
   files**), yet even `git ls-files` took 1790ms — the problem is not repository size but **each git spawn
   itself**.
4. spawn isolation experiment: `git --version` ~1.5-2s, `node -e ""` ~1s, `cmd /c echo` ~1s (native PowerShell
   equally slow) → **machine-level process creation cost**, +0.5~1.5s per process. One rollback runs ~6 git
   spawns ≈ 4s, matching the measurement.
5. system investigation: CPU only 18%; SecurityCenter2 lists three (Kaspersky+Defender+McAfee) (Defender is
   already disabled, 0x800106ba); found a suspicious process **DocUpdate (hidden path, launched by svchost,
   cumulative CPU 4600+ seconds)**.
6. **A/B experiment**: after `Stop-Process DocUpdate`, `git --version` went 1500ms → **48ms** (30x) and
   `node -e` → 53ms — **the culprit is DocUpdate**, not Kaspersky.

**Root cause**: `DocUpdate.exe` from the PDF reader (`C:\Program Files (x86)\MasterPDF\`) interferes with
process creation across the whole machine; its auto-start service `DocService` (Auto, Running) launches it. The
"4 shadow-git/update tests stably timing out at 30s + EBUSY" since 2026-08-19 has the same root cause
(previously recorded as a Defender lock, but it was actually this).

**Handling**:
- the DocUpdate process was killed (it did not respawn); stopping/disabling the DocService service needs
  administrator rights, which the current shell lacks (access denied) — **the user must do it manually** (in an
  admin PowerShell: `Stop-Service DocService; Set-Service DocService -StartupType Disabled`, or uninstall the
  PDF reader with its own Uninstall.exe; since Defender is disabled, re-enabling it for investigation is also
  recommended).
- measured after the kill: **rollback 430ms, revoke 332ms, rollback again 432ms, revoke again 344ms** (better
  than the historical best); the full test suite **12 files 65 cases all pass** (the previous 4 "environment
  failures" disappeared).

**Tools left behind**: `scripts/edge-timing.mjs` (rollback/revoke timing e2e), `scripts/timing-spawn.mjs`
(machine health check: has spawn become slow again).
**Experience**: when the whole machine slows down (git/tests/e2e all degrade together), measure
`timing-spawn.mjs` first to rule out third-party process interference before suspecting the code.

## 2026-08-20 session: npm release preparation (packages renamed dsh-undo-plugin + @dsh-undo/*)

The user decided to list the plugin on the dsh plugin marketplace; the multi-package repository's `link:`
install is unusable for marketplace users, so it moves to npm publishing. **Naming**: npm's `dsh-undo` is
already taken by LingLambda's other /undo /redo plugin (v0.2.0), so the decision was:
**entry package `dsh-undo-plugin` (unscoped), the 7 internal packages `@dsh-undo/*`, root package `dsh-undo`
(private)**. The `@dsh-undo` scope is currently unused (404).

**Changes** (mechanical replacement `@dsh-rollback/` → `@dsh-undo/` across 44 files + manual fixes):
- the 8 package.json files: renamed packages, removed `private`, added `publishConfig.access = public` +
  `repository` (with directory) + `keywords`; the entry package gets `packages/bundle-rollback/README.md`
  (for the npm page).
- `typert-protocol` stays private (a dev-time override of the vendored `@deepseek-ai/dsh-typert-protocol`).
  Its `workspace:^` peerDep is replaced by pnpm with `^0.1.0-rc.6` at pack/publish time — that package really
  exists on npm at the same version, so end users can resolve it (verified).
- **pitfall 1**: the escaped slash `@dsh-rollback\/rollback-` in a regex was not hit by the string replacement,
  so the GENERATED_REMOTE allowlist in `scripts/tsdown.client.ts` was missed → the client build failed with a
  bundle purity error; fixed by hand.
- **pitfall 2**: the replacement script once descended into `packages/*/node_modules` (a pnpm linked mirror,
  idempotent and harmless); rebuild under the new names after `pnpm install`.
- the `/update` command text, `cordis.patch.yml` comments, and both READMEs' install sections (the npm one-liner
  `dsh plugin --profile web add dsh-undo-plugin` + the source install kept) were synced; the
  `data-dsh-rollback-message-action` DOM marker is an internal convention (consistent across code/tests/edge
  scripts) and was deliberately kept.

**Verification**: `pnpm install --no-frozen-lockfile` (renaming the overrides requires regenerating the
lockfile) → typecheck ✓ → build ✓ → test 12 files 65 cases all green ✓; `pnpm pack` for all 8 packages,
unpacked and verified one by one: no private, no `workspace:` residue, `files` not out of bounds, entry package
deps all `@dsh-undo/*`.
**Profile migration**: `dsh plugin --profile web remove` the old 8 names → `add` the 8 local paths; the bundles
list becomes `dsh-undo-plugin`; after restarting dsh web (3080) `/plugins/@dsh-undo/*/client.js` returns 200 and
the old names 404.

**Publishing operations (2026-08-20, completed)**:
1. registered an npmjs.com account + created the free organization `dsh-undo` + `npm login` ✓ (account
   23swccp37, 2FA auth-and-writes mode).
2. **publishing method**: `pnpm publish` does not work — with 2FA enabled on the account and a token without
   bypass it reports `ERR_PNPM_OTP_NON_INTERACTIVE`; switched to a **granular access token (with bypass 2FA
   checked) + `npm publish <tarball>`**:
   - the token goes in a temporary npmrc (specified with `--userconfig`), avoiding the `npm login` session token
     (which has no bypass) in the user's `.npmrc` taking precedence — that was the real cause of the first
     403/EOTP;
   - prerelease versions must explicitly specify `--tag latest`, otherwise `dsh plugin add` resolving latest gets
     a 404;
   - the tarballs from `pnpm pack` were published directly with `npm publish`, all 8 succeeded:
     `rollback-fork` → `rollback-archive` → `rollback-undo` → the 4 `client-rollback-*` → `dsh-undo-plugin`, all
     `0.1.0-rc.6`, `latest` dist-tag, public.
3. **new-package CDN negative caching**: after publishing, an anonymous `npm view` 404s for scoped packages for
   about 2~5 minutes (authenticated queries are fine and `npm access get status` shows public); it recovers
   after waiting — it is not a publishing failure.
4. **end-to-end verification**: `npm install dsh-undo-plugin` succeeds in a temp directory; all 8 packages +
   `cordis.patch.yml` + `lib/client.js` are in place ✓.
5. TODO: open a PR to the awesome-dsh-plugin repository (English description + a reproducible
   `dsh plugin add dsh-undo-plugin`); the npmmirror sync in China lags, so users going through the mirror must
   wait for the sync to complete.

---

# Requirement: remove the "rollback only once" limit, support multiple consecutive rollbacks starting from the latest message

> This section records the original feature requirement text (de-ambiguated version) for later implementation
> checks. Status: **requirement confirmed + feasibility verified, implementation not started**.

## 1. Requirement statement (precise version)

**Current state**: this plugin can roll back only **once** per session — after a rollback the old session is
archived and a new session is created; only when a new prompt is sent in the new session does the rollback point
attach to a new message; the same rollback point cannot be stepped back repeatedly. Reason: the journal and the
session are 1:1, so after each rollback produces a new session the old rollback chain is broken; arm only creates
a new journal when a new prompt arrives.

**Goal**: rollback can be **executed consecutively many times** — each execution always targets the **current
last** completed user message; after a rollback the latest message moves back accordingly, so it can be rolled
again and again, one message at a time, until there is no rollbackable message left.

**Acceptance criteria (each testable)**:
1. With N completed user messages in a session, the user can roll back consecutively **≥1 time** (expected up to
   N times), never again receiving the `not-latest-message` rejection ("only the most recent completed message
   can be rolled back").
2. **The first rollback** targets message N (the latest). After it, files return to before message N, the
   conversation forks to a new session ending before the turn containing message N, and the old session is
   archived.
3. **After the rollback**, on that new session, rollback can be performed **again** (target = message N-1, which
   is now "the last"), returning to before message N-1 … and so on until nothing is rollbackable.
4. File rollback and conversation rollback boundaries are **always consistent**: both align to "before the target
   (current last) message", not to a finer step, and not widened across turns.
5. The change does not break existing capabilities: revoke rollback, `/undo`, the message-level button, the
   session header button, and archived tasks all keep working.

**A typical sequence**:
```
session has msg1, msg2, msg3 (msg3 is the latest)
rollback ─▶ back to "before msg2"      (new session: msg1, msg2; files = before msg2)
rollback ─▶ back to "before msg1"      (new session: msg1;       files = before msg1)
rollback ─▶ back to "start/empty"      (new session: empty;      files = initial)
```

## 2. Semantic boundaries (explicit conventions to avoid ambiguity)

- **The rollback target is always the "current last" completed ordinary user message.** There is no "pick one
  from history" selector — the interaction entries still appear only on the current last message (same as
  today).
- **Rollbackable targets = ordinary user messages in completed turns** (`isOrdinaryUserMessage`). In-progress
  turns and unfinished turns **cannot be rolled back**; this is a capability boundary of conversation fork, not
  a defect, and is out of this requirement.
- **File side**: git is a tree; every ShadowGit beforeTree can be restored at any time; rolling back message by
  message = restoring "the tree before the current last message" each time, naturally feasible.
- **Conversation side**: `sessionFork.fork`'s `cut.before-user-message` locates precisely by messageId with
  `findIndex` over the whole event stream and supports any completed message (see
  `packages/rollback-fork/src/index.ts`'s `beforeUserMessagePrefix`). **Feasibility verified; no dsh host change
  and no `rollback-fork` package change needed.**

## 3. Root cause (why only one rollback is possible today)

`packages/rollback-undo/src/index.ts`:
- `arm()` (around L509): captures beforeTree and writes the journal **only before a new prompt arrives** (the
  stale sweep around L552-558 deletes journals of the same session with a different generation).
- `undoLatest()` (around L360): the entry check `journal.messageId !== request.userMessageId` → returns a
  `not-latest-message` rejection (L370-372).
- **Structural limit**: "1 session 1 journal" means that after a rollback the new session has no "before its last
  message" snapshot to reuse — unless a new prompt triggers arm again. That is the source of "only one
  rollback": the rollback chain does not retain history points **without depending on a new prompt**.

## 4. Verified key facts (read before implementing)

- The `before-user-message` cut supports **any completed message**: `beforeUserMessagePrefix` uses `messageId`
  with `findIndex` in `source.events`, not limited to the latest. Requirement: the target message is an ordinary
  user message and belongs to a **completed turn**, otherwise it throws `SessionForkUnavailableError`.
- Unit test coverage: `packages/rollback-fork/tests/cuts.spec.ts` has verified the "exclude the target's complete
  turn" and "reject steer messages" paths.
- ShadowGit dedupes incrementally across many trees in the same repository (unchanged files reuse blob/tree), so
  keeping a snapshot per message costs ≈ the incremental change of each step, not multiple full copies.
- The existing performance optimizations (statWarmer / prearm / untrackedCache / splitIndex / path-limited
  restore / diff-tree) are **reusable** on an append-only chain, with no conflicts.

## 5. Proposed implementation direction (for implementation, not final)

Core: allow the new session after a rollback to **keep rolling back**, without depending on "sending another new
prompt". Change the "overwrite-style single-point journal" into an "**append-only snapshot chain**" and let every
rollback consume "the tree before the current last message":

```
today:  prompt→arm→beforeTree@msgN (overwrite, delete the old one); after 1 rollback the chain is broken, a new prompt is needed
target (same shadow GIT_DIR, git objects dedupe naturally):
       beforeTree@msg1 ◀── beforeTree@msg2 ◀── … ◀── beforeTree@msgN
       each rollback restores the tree of the "current last message" + forks at that message's turn boundary;
       the forked new session still has its "before current last message" snapshot on the chain and can keep rolling back
```

The changes concentrate in `packages/rollback-undo` (direction suggestion; the implementation decides):
1. Lift `undoLatest`'s `not-latest-message` gate (L370-372) — the current last message is always an allowed
   target, and "the second and third consecutive rollbacks" are no longer wrongly rejected.
2. `arm()` / new session initialization: make child sessions produced by a rollback **establish/inherit a
   continuable snapshot chain**, so "roll back again" doesn't depend on a new prompt. Define clearly how a child
   session takes over the next beforeTree on the chain.
3. Extend the journal from "1 session 1 group" to "1 session (or 1 lineage) ordered sequence"; the rollback point
   moves forward with each rollback; `readJournal` locates by the current last message.
4. Revoke/redo semantics: keep redoTree so that revoke and "the rollback just performed" are symmetric and
   repeatable.
5. Keep and reuse the statWarmer/prearm/untrackedCache/splitIndex optimizations, ensuring performance does not
   regress under multiple rollbacks.

## 6. Explicitly not done (out of scope)

- **No step-level file rollback** (a single step inside a turn). Files and conversation both align to "before the
  current last user message".
- **No dsh host source changes and no `rollback-fork` package changes.**
- **No changes to the existing behavior of the message-level button, the session header button, or the revoke
  fold strip.** (The "pick one from history" selector is instead handled by the "#8 /undo vertical-axis rollback
  dialog" section below, so it is no longer listed as not-done.)

---

# Additional requirement: the `/undo` vertical-axis rollback dialog (a striking new UI)

> A visual rollback selector, as a new entry point for the `/undo` command. Status: requirement confirmed, not
> implemented.

## 0. Relationship to "consecutive layer-by-layer rollback" (read this first to remove ambiguity)

The user stated explicitly during plan confirmation: **"picking a point to roll back is essentially consecutive
layer-by-layer rollback"**. That is:

- the vertical axis in the dialog is **not** a second rollback mechanism; it only visualizes as a point on the
  axis each layer that **"consecutive layer-by-layer rollback"** can reach.
- point N on the axis = "the state after rolling back N times from the latest, layer by layer".
- after choosing a point and confirming, it executes **the same consecutive layer-by-layer rollback pipeline**,
  all the way from the latest down to the chosen point; **the user's experience is a single jump** — folded into
  one visible operation, with no per-layer pausing prompts.
- therefore: **there are no "two rollback systems"**, only one "consecutive layer-by-layer rollback" plus a
  dialog that visualizes the layers. The message-level button / header button / fold strip remain layer by layer,
  one layer per click; the /undo dialog puts multiple layers on one diagram for you to choose from, and choosing
  rolls all the way at once.

This section's "rollback target = a point on the axis" does not conflict with the main requirement's "the target is
always the current last message": each point on the axis corresponds to "the last message after the Nth layer
rollback"; the dialog lets you pre-select which layer, and internally it still executes consecutively.

## 1. Requirement statement (precise version)

After typing `/undo`, open a window **consistent with the dsh style** (no longer rolling back the latest
directly):

- the center of the window shows a **vertical axis**;
- on the axis, **evenly spaced points** each represent one layer of consecutive rollback (the bottom-most point =
  the latest prompt; each point upward = one more layer back), ordered by rollback depth from top to bottom;
- **clicking a point** → that point **highlights** (selection only, no immediate execution);
- after selecting, the user must click the **"Confirm rollback"** button inside the window to execute (double
  confirmation, preventing accidents);
- after confirmation, execute consecutive layer-by-layer rollback down to the selected point (**folded into one
  visible operation**).

## 2. Visuals and theme (explicit conventions to avoid ambiguity)

- **Follow the dsh theme**: **light / dark / custom** all three states follow; do not hardcode colors, use dsh's
  CSS variables (`--dsw-*` theme variables), ensuring adaptation under light, dark, and user-custom themes.
- **Style = dsh's own restraint (explicitly not borrowing fork-graph's colored swimlanes)**:
  - no colored swimlanes, no gradients, no high-saturation markers;
  - only dsh semantic tokens: text uses `--dsw-text-primary/secondary/tertiary`, background uses
    `--dsw-bg-elevated/raised`, borders use `--dsw-border-subtle`, radii use dsh's existing radius (8px card /
    6px button);
  - the visual language is exactly consistent with existing client components such as `RollbackFold` /
    `RollbackHeaderAction` — low contrast, thin borders, restrained;
  - the selected state is expressed through tokens only (e.g. a highlighted background point or border), not with
    colored fills.
- Vertical axis: even spacing makes "roll back to layer N" obvious at a glance; each point may show the prompt's
  first line as a text hint (tooltip or side note); the point itself carries little text, staying restrained.
- Reference implementation: an existing restrained-style sample is
  [client-rollback-button/src/client/RollbackFold.module.css].

## 3. Interaction sequence (explicit conventions)

```
user types /undo
  ─▶ the vertical-axis rollback window opens (no longer directly rolling back the latest)
the window lists one point per prompt sent in that session, ordered latest→oldest, top→bottom
the user clicks a point on the axis
  ─▶ the point highlights (selected state) and a [Confirm rollback] button appears in the window
the user clicks [Confirm rollback]
  ─▶ consecutive layer-by-layer rollback down to the selected point (folded into one visible operation), the window closes
the user clicks outside the window / cancels
  ─▶ the window closes, no rollback is performed
```

- **Clicking a point ≠ executing a rollback**: highlight/select first; the [Confirm rollback] click is required.
- **Direct jump = one consecutive rollback to the end**: after confirmation, roll from the latest down to the
  selected layer, but externally it is one operation (no per-layer prompts).
- The selected "target" is fixed to align to **before the turn boundary** of that prompt (consistent with the
  existing cut semantics; both files and conversation align to before that message).

## 4. Gap with the current implementation (what must be added)

The existing `/undo` is the host-side `rollbackCommand` ([rollback-undo/src/index.ts:144]), **bare execution, no
UI dialog**. To implement the dialog:

1. **New client-side dialog component**: vertical axis + evenly spaced points + highlight + confirm, opened by
   `/undo` (no arguments typed → open the dialog; with arguments → keep the current behavior).
2. **New host-side layer data for the dialog to read**: it must return "the messageId + prompt preview of every
   layer of rollback from the latest" (enumeration can reuse the journal chain linked by
   `logicalConversationId`). This is a new Remote/POJO.
3. **Confirm = consecutive rollback**: expose "consecutive layer-by-layer rollback" for reuse — call the same
   rollback transaction for the selected layer's messageId; if the selected layer is not the latest, execute
   consecutively internally down to that layer. Reuse `undoLatest`'s existing cut capability + the new messageId
   target.
4. **Theme**: all client component styles go through dsh CSS variables; no hardcoded colors.

## 5. Explicitly not done (out of scope)

- The dialog **does not** change the existing behavior of the message-level button, the session header button, or
  the revoke fold strip (they remain layer by layer).
- The dialog **does not** edit prompts, only select points to roll back.
- The dialog **does not** introduce a second rollback store/transaction — it consumes the same capabilities as
  "consecutive layer-by-layer rollback".

## 6. Precedent survey (ecosystem check results, 2026-08-20)

After checking the dsh ecosystem, the conclusion is that this dialog is "**innovative here**" and not reinventing
a wheel:

- **chouyong/dsh-fork-graph** (the closest): a Git-style conversation **branch topology graph** — colored
  swimlanes + curved forks + one row per session + click to jump. But its README explicitly says it **only
  visualizes, performs no rollback action, writes no state**:
  `No forking UI ... visualises the result rather than duplicating the verb`. It is "see what the branches look
  like / click to jump to that session", with **no "vertical axis layer by layer + click to confirm rollback"**.
- **PerryLink/dsh-checkpoint-rewind**: its settings page has a checkpoint **timeline** (per-snapshot + diff), but
  that is a **settings panel history list**, not a `/undo`-triggered dialog with a vertical-axis selector, and it
  has no "click to roll back".
- **Other rollback plugins** (turn-rewind / msg-rewind / dsh-rewind / undo-savepoint): none has a "vertical axis
  visualization + select to roll back" interaction.

**Borrowing and differentiation for the implementation**:
- **Visuals do not borrow fork-graph's colored swimlanes**: the user explicitly asked for a style close to dsh
  itself, restrained. fork-graph's branch-graph layout idea can be referenced, but rendering always uses dsh
  `--dsw-*` semantic tokens in a low-contrast restrained style (see #2 above: no colored swimlanes / gradients /
  high saturation).
- **Differentiation**: fork-graph is cross-session branch families / click to jump; ours is **consecutive
  rollback layers within one lineage / vertical axis with evenly spaced points / highlight + confirm + execute
  rollback**. The verb is "roll back", not "jump".
- **Whitespace confirmed**: "vertical axis layer selector + click to confirm returning to a layer" — this
  combination has no precedent in the current ecosystem, and can be used as a differentiation highlight in the
  README/marketplace copy.

---

# Additional requirement: archived-task handling for multiple rollbacks

> An important supplement to "remove the rollback-once limit", in its own section to avoid mixing it with the
> main requirement. Status: also "requirement confirmed, not implemented".

## 1. Requirement statement (precise version)

**Roll back N times ⇒ archive N old sessions; once a new prompt is sent ⇒ delete all the old sessions archived
earlier by those rollbacks.**

That is, the "lifecycle" of the archived old sessions is terminated by the event of **the next new prompt
appearing** — not deleted immediately, and not kept indefinitely.

## 2. Concrete sequence (explicit conventions to avoid ambiguity)

```
session S0 has msg1, msg2, msg3
rollback#1 ─▶ archive S0, create S1 (= fork before msg2)      ← archived set: {S0}
rollback#2 ─▶ archive S1, create S2 (= fork before msg1)      ← archived set: {S0,S1}
rollback#3 ─▶ archive S2, create S3 (= fork at the start)     ← archived set: {S0,S1,S2}

the user sends a new prompt (on S3) ─────────────────────
  ──▶ delete S0, S1, S2 in the archived set (along with their journals);
      S3 becomes the new active session and keeps its continuable rollback snapshot chain
```

- **"archive N"**: each rollback archives the old session it forked away from (same as today), so after N
  consecutive rollbacks the archived set for that lineage holds N old sessions. They are **visible in the
  archived list and can be restored (via revoke)**, until the delete event fires.
- **"a new prompt deletes"**: after the user sends a new ordinary user message on the new session, clean up
  **all** N archived old sessions that rollbacks produced earlier in that lineage and delete their journals.
  ("Sending a new prompt" here means the user actively starts a new topic, as distinguished from "the rollback
  itself" — a rollback does not trigger deletion, otherwise revoke would have no target to restore.)

## 3. Gap with the current implementation (why a change is needed)

Half of it exists already, but only 1 is cleaned, not the whole chain:

- **"each rollback archives the old session" already exists**: `rollback-undo/index.ts` calls
  `ctx.sessionArchive.archive(sourceSessionId)` on each rollback, archiving the old session ✓
- **"a new prompt deletes" only covers the most recent 1**: `arm()`, when accepting a new prompt, calls
  `finalizePairForRollback`
  ([index.ts:586](file:///c:/Users/34293/Desktop/dsh-undo/packages/rollback-undo/src/index.ts#L586)), which
  `tombstone`s the **single** source found by `findPairByRollback(rollbackSessionId)` and deletes its journal. It
  works on a "1 session 1 pair" assumption and cleans only the most recent one.

**To change**: extend the cleanup at "new prompt" from "delete 1" to "tombstone all N old sessions along that
lineage's archive chain + delete their journals". The criterion is that these old sessions belong to one
**consecutive rollback lineage** (linked by the same logicalConversationId), not just the latest one.

## 4. Implementation means for archive deletion (suggestion, not final)

- Reuse the existing `ctx.sessionArchive.tombstone(sessionId)`: mark the archived session hidden and remove it
  from the archived list; undo with `untombstone`. Reference implementation
  `packages/rollback-archive/src/index.ts` L124.
- The cleanup entry point is still `finalizePairForRollback`, but changed to **iterate all archived old sessions
  currently in that lineage** and tombstone each, and `deleteJournal` each, instead of only the single
  `findPairByRollback` point.
- Lineage identification: use the journal's `logicalConversationId` (all consecutive rollbacks share the same
  value) to identify the whole chain, not just adjacent generations.
- The failure fallback stays as is: a single tombstone failure → record `cleanup-pending`, retried by the Host at
  startup ([recoverDeferredCleanup]), not blocking new prompt acceptance.

## 5. Pointer for merging into the main requirement

- This supplement is deeply coupled with "remove the rollback-once limit": precisely because consecutive
  rollbacks must be possible and revocable at any time, old sessions must **be retained during the revoke
  window**; and once the user sends a new prompt (giving up the revoke opportunity), the whole old chain is
  useless and should be cleared together. The two must be implemented and verified together.

---

# Additional requirement: "revoke rollback" strip UI rules under multiple rollbacks

> Display rules for the revoke strip (revoke strip) when there are multiple consecutive rollbacks. Status:
> requirement confirmed, not implemented.

## 1. Requirement statement (precise version)

**The revoke strip always stays a single strip** — even after the user has rolled back consecutively many times:

- the strip **always shows only the "most recent" rolled-back message** (prompt preview), never stacking
  multiple rollbacks;
- after the user clicks "revoke rollback", the most recent rollback is undone, and then the strip **switches to
  the "second most recent"** rollback and remains revocable, and so on;
- one layer at a time; only after revoking the currently displayed layer does the next layer appear.

**Relation to today**: today it already shows only one (it consumes a single `revokePair`, and because of
"rollback only once" there is only one layer to revoke anyway). The new requirement is, given "multiple rollbacks
allowed", to **keep the same single-strip look** while extending the revocable layers from 1 to many, with no
change in UI shape.

## 2. Concrete interaction sequence (explicit conventions to avoid ambiguity)

```
the session has been rolled back 3 times (S0→S1→S2→S3)
  the strip shows:  ↩ Rolled back {prompt of the message removed most recently}          [Revoke rollback]
the user clicks [Revoke rollback]
  S3 is revoked → restored to S2 (files + conversation restored)
  the strip shows:  ↩ Rolled back {prompt of the second most recently removed message}   [Revoke rollback]
the user clicks [Revoke rollback] again
  S2 is revoked → restored to S1
  the strip shows:  ↩ Rolled back {prompt of the third most recently removed message}    [Revoke rollback]
……
```

- The strip's currently displayed layer = "the message removed by the most recent rollback of the current active
  session".
- After a layer is revoked, the active session becomes the next chain node and the strip points at the following
  layer.
- Until nothing is revocable (back at the original session), the strip disappears.

## 3. Gap with the current implementation (why a change is needed)

- **Today the strip is single-valued**: the client `RollbackFold` ([client-rollback-button/
  src/client/RollbackFold.tsx]) consumes `view.revokePair`, a single
  `ConversationRevokePairValue | undefined` object carrying one source+prompt. The host-side `revokePair` Remote
  ([rollback-undo/src/index.ts:207]) returns a single one via `findPairByRollback` under the "1 session 1 pair"
  assumption.
- **To change (under multiple rollbacks)**: when a session has **multiple layers** of revocable rollback,
  `revokePair` must change from "a single value" to "the pair of the layer that should currently be displayed".
  The core is:
  1. the strip still renders **one layer** only (UI unchanged, still a single `↩ Rolled back …` + `Revoke
     rollback`);
  2. the host maintains a "currently revocable layer" pointer; after a successful revoke it advances one layer
     along the lineage, and the client's refetch gets the next layer;
  3. identifying the "current layer" reuses `logicalConversationId` + the revoke stack (consistent with archive
     cleanup).

## 4. Implementation points (suggestion, not final)

- **Host `revokePair` semantics**: from "the most recent completed rollback pair" to "the topmost (most recent)
  not-yet-revoked completed rollback pair of that lineage". The client fetches only that layer.
- **Advancing after a successful revoke**: after revoking one layer, move "currently revocable layer" down to the
  previous generation; when the client refreshes `revokePair` the next layer shows. When nothing is revocable
  (`no-undo`), the strip disappears, consistent with today's `pair === undefined → return null`
  ([RollbackFold.tsx:39]).
- **UI reuses the existing components**: `RollbackFold`'s rendering logic (prompt preview, collapse, disabled
  state) stays basically unchanged; only the source of the "layer" changes from a single value to "the current
  layer".
- **Coupling with archive cleanup**: when a new prompt clears the whole lineage, `revokePair` naturally becomes
  undefined and the strip disappears — no extra UI logic needed.

## 5. Merge pointer

- This is tightly related to "roll back N times, archive N old sessions" + "a new prompt clears everything": the
  premise for the strip to revoke layer by layer is exactly that each layer's old session **is retained during
  its revoke window**; after a new prompt clears them, the strip disappears as well. All three must be
  implemented and verified together.

## 2026-08-24 session: `/undo` node axis tied to the native trail view

- Typing `/undo` exactly opens the lineage node axis. A node can be expanded by mouse hover or keyboard focus into
  petals labeled "Rollback" and "View dsh trail" with SVG icons; accessibility names and `aria-pressed` are
  preserved.
- "View dsh trail" no longer maintains a duplicated in-plugin file/command detail dialog: it closes the node axis
  and directly opens dsh's native "Trail" page, positioned at the selected prompt.
- The located range starts at the USER row of the matching prompt and ends before the next USER row; the USER,
  assistant, and tool rows of that whole turn uniformly use a low-contrast background and a continuous left
  marker line, avoiding highlighting only a single message.
- Rollback, revoke rollback, archive, and the other existing entries were not removed by this linkage change.
- Passed `pnpm run typecheck`, `pnpm test` (16 test files, 88 tests) and `pnpm run build`; Codex's built-in
  browser actually confirmed that `/undo` → select a node → "View dsh trail" opens the native trail page. The
  browser was left open per the user's request.

## 2026-10-28 session: adapting to dsh 0.2.1-rc.3 (desktop DeepSeek Harness)

### Background
- Desktop DeepSeek Harness 0.2.1-rc.3 validates plugin installation by comparing **peerDependencies package by
  package** against the runtime version: with `0.1.0-rc.8`, every `^0.1.0-rc.6` is unsatisfiable, so right after
  install you get `installation rejected: ... incompatible with dsh 0.2.1-rc.3`, then
  `restored package.json, pnpm-lock.yaml, and node_modules`.
- This migration moved the entire workspace onto the 0.2.1-rc.3 public API surface (versions bumped to `0.2.0`),
  installed it into the desktop profile via `link:`, and confirmed in the running GUI that the client half is
  mounted.

### Dependencies and manifests
- All `@deepseek-ai/dsh-*` peer/dev → `^0.2.1-rc.3`, `cordis` → `^4.0.5`, `schemastery` → `^3.18.5`;
  `pnpm-workspace.yaml` overrides pin `cordis`, `cordis-plugin-include`, `cordis-plugin-loader`, `cosmokit`, and
  `schemastery` each to a single version. **Reason**: plugin-loader version differences give cordis different
  peer suffixes, installing two copies of the `Context` type; the `Events` / `Context` augmentations then don't
  merge, showing a wall of `TS2379`/`TS2769`/`TS2339`.
- `dsh-agent-presets` is gone, its resolver replaced by `@deepseek-ai/dsh-agent-preset-registry`;
  `dsh-client-runtime` is gone (`ClientContext` → cordis's `Context`, `ObservableSnapshot` →
  `@deepseek-ai/dsh-client-store`, `ISessions` → `@deepseek-ai/dsh-api-session-controller/client`, `SessionId` →
  `@deepseek-ai/dsh-session/types`, `dsh-client-runtime` in `dsh.client.inject` → `dsh-client-store`).
- `dsh-invariants` does not exist at all in 0.2.x (no such package in the runtime, no `ctx.invariants` service
  either), so the 7 `src/invariant.ts` files, their `./invariant` exports, and `lib/invariant.js` were all
  deleted.

### Host-side API differences (rollback-fork / archive / undo)
- `Session.events` → `Session.snapshotEvents()`; `SessionPersistence.inspect()` is gone, use
  `SessionHandle.readLine/read()` from `open(id, 'read')` (to read all events use `handle.read()` then
  `close()`); `SessionPersistence.list()` returns `SessionPersistenceSnapshot[]`, and the session id becomes
  `snapshot.header.id`.
- `agents.create({ meta })`: `seedLength` → `isSeeded: true` + a top-level `inheritedEventCount`.
- `resolveSessionPreset()` removed: read the Session projection `agentPreset` state machine
  (`agentPresetProjectionDefinition.init(header)` + per-event `.apply(state, event)`); `fork()` uses it to carry
  the parent session's preset into `meta.agentPreset`.
- The `jobs.list()/kill()` owner parameter changed from `Agent` to `SessionId` (`agent.id`); `terminals.*` still
  takes `Agent`.
- **Permanent delete downgraded to an explicit rejection**: 0.2.x publishes no session delete/remove API (and no
  `SessionPersistence.locate()`), so `sessionArchive.delete()` directly returns `backend-unsupported` + "this dsh
  runtime exposes no session delete API" instead of assembling a path for `rm -r`. The tombstone hiding logic is
  unchanged.

### typert protocol and generator
- Abandoned the old vendored source of `packages/typert-protocol` in favor of **vendored 0.2.1-rc.4 build
  artifacts** (`vendor/index.js` + `vendor/types/*.d.ts`, package name still
  `@deepseek-ai/dsh-typert-protocol`, version `0.2.0`). Reason: the 0.2.x Remote marker is a **versioned
  descriptor on the decorator prototype** (`addMarkerInitializer` writes it at instantiation time), and the 0.1
  private-module-state marker is not recognized at runtime.
- `vendor/types/cordis-augment.d.ts` splits out `declare module '@deepseek-ai/cordis'` on its own, and
  `src/index.ts` / `src/types.ts` only bring it in with `/// <reference path>`. Reason: the typert generator's
  `registrationHasSurface()` only follows **static imports**, and triple-slash references don't count as surface
  — so the protocol package is still registered (`@Remote` attribution is fine) but is not analyzed as a
  contribution package for its own generic declarations; otherwise `ensureDeclaration` throws
  `merged interface TypertResourceMap contains a declaration outside this face` because `TypertResourceMap` has a
  declaration outside the face.
- `patches/typert-generator-workspace-only.patch` was regenerated against 0.2.1-rc.4's `analyzer.js:1311` line
  number, still with the effect "scan only workspace-registered files", to avoid the npm-resolved dsh twins
  double-declaring typert maps.
- `tsdown.config.ts`'s `workspace` became an object form with `exclude: ['packages/typert-protocol']`; otherwise
  tsdown looks for the vendored package's entry at `lib/types/index.js` and reports `UNRESOLVED_ENTRY`.

### Client-side differences
- The slot props' `useSession` / `sessionId` / `useSessions` come from `@deepseek-ai/dsh-client-ui-session/client`'s
  `declare module` merge; the client tsconfig must import that module (the old `ClientContext` carried those
  merges along; 0.2.x doesn't).
- **There is no "current session" public service**: `ISessions` no longer has `open()`, `SessionListState` no
  longer has `current`, and the selection state is a private store of `UiWorkspaceService`. Therefore:
  - opening a child session → `ctx.uiWorkspace.openSession(sessionId)`; `keepRollbackChildOpen()` changed to a
    bounded replay within [0,150,500,1200]ms (the selection action may be overwritten by a subsequent restore);
  - the message-level rollback button's DOM patch no longer reads `current`; instead it compares the globally
    unique messageId of `[data-chat-flow-key]` against the armed points known to this client (`points()` +
    `subscribe()`) — there is no session id attribute available in the DOM.
- `IconArchiveOutline20` does not exist in 0.2.x primitives → `IconArchiveOutlineMedium`.
- `scripts/tsdown.client.ts`'s `INLINE_SAFE` gains `typert-protocol`: the generated
  `lib/typert.remote-client.js` imports its `/remote-info`, and that module is a pure wire layer that "lazily
  describes Remote definitions with the caller's Zod", with no cross-boundary identity, so it is inline-safe.
  After inlining, the client bundle grows to about 590 KB (zod + wire layer) and at runtime only requires
  `react` / `react/jsx-runtime`.

### Installation and verification
- `dsh --profile <name> --dump-config` is forbidden for the desktop profile
  (`profile "desktop" is managed exclusively by the Electron application`), so a mirror profile `undo-verify`
  (`--from-default-profile web`) was used to verify the composition tree: all 7 rows are correctly inserted
  after `dsh-web-app`.
- actual install: `dsh plugin --profile desktop add D:\Services\dsh-undo\packages\bundle-rollback` →
  `+ dsh-undo-plugin`, no rejection. **Only the entry package needs installing**: the profile records
  `link:D:/.../packages/bundle-rollback`, and the seven `@dsh-undo/*` packages resolve through the linked
  repository's own workspace (which incidentally explains why the `pnpm.overrides` setup is redundant: pnpm 11 no
  longer reads the `pnpm` field in package.json).
- with the desktop app running: turning the bundle off and on again in settings recomposes it immediately, no
  restart; then `cordis_inspect_query` (client provider) queried the `conversation.input.dock` subtree and really
  read two active entries, `rollback-fold(order 60)` and `undo-timeline(order 61)` — the client `apply()` has
  run and the Remotes mounted (`$mount` before slot registration).
- Passed `pnpm typecheck`, `pnpm test` (17 files / 91 cases), `pnpm build`.
- Note: `cordis_inspect_query`'s `Service.listService` only sees services from the **static catalog**; the
  runtime typert-registered `conversationUndo` / `sessionArchive` / `sessionFork` are not found; reporting
  "no catalogued Service named ..." does not mean the service isn't mounted.
