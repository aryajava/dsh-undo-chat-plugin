# dsh-undo-plugin

Conversation undo/rollback plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

- **Message-level rollback** — the enter-key icon under a sent prompt, the session-header rollback button, the `/undo` command, or the composer strip: restores the file tree from a plugin-private Shadow Git snapshot (never touches your `.git`) and forks the conversation, so the model never sees the reverted prompt, reply, or tool calls
- **`/undo` node axis** — exact `/undo` opens a lineage timeline: choose a rollback point or hand the selected turn to dsh's native Trajectory view, where the full selected turn is marked
- **Archive tasks** — list, restore, and permanently delete archived sessions from Settings
- **Tool cards** — per-tool colored cards and the reasoning-and-actions fold in the dsh web conversation trail

## Install

```sh
dsh plugin --profile web add ./packages/bundle-rollback
```

Requires `dsh` 0.2.1-rc.3. On the desktop app, swap `--profile web` for `--profile desktop`. The bundle installs as a `link:` into this checkout, so build it first with `pnpm install && pnpm build`, then restart `dsh`.

Full documentation: [dsh-undo-chat-plugin](https://github.com/aryajava/dsh-undo-chat-plugin#readme)

## License

MIT
