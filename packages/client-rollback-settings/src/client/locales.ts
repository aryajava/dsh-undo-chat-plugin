/**
 * Copy dictionary for the Archive Tasks Settings section.
 *
 * The plugin ships a single English copy. The locale service expects a
 * dictionary per supported locale, so callers bind this one to every slot; no
 * second-language strings exist in this project.
 */

/** English dictionary and the key source of truth for this section. */
export const en = {
  nav: 'Archive Tasks',
  title: 'Archive Tasks',
  description: 'Archived conversations can be restored as a new session; deleting permanently erases their log files.',
  loading: 'Reading archived tasks…',
  loadFailed: 'Archived tasks are temporarily unavailable.',
  retry: 'Retry',
  empty: 'No archived tasks.',
  view: 'View',
  restore: 'Restore',
  close: 'Close',
  viewerTitle: 'Archived conversation (read-only)',
  noMessages: 'This conversation has no text messages to display.',
  cleanupPending: 'Waiting for automatic cleanup.',
  recoveryRequired: 'Rollback recovery needs Host attention; do not continue using this workspace until it completes.',
  delete: 'Delete',
  confirmDelete: 'Confirm permanent delete',
  cancel: 'Cancel',
  deleting: 'Deleting…',
  deletePrompt: 'Permanently delete this conversation\'s disk logs? This cannot be undone.',
  deleteAll: 'Delete all',
  confirmDeleteAll: 'Confirm delete all',
  deleteAllPrompt: 'Permanently delete every archived conversation\'s disk logs? This cannot be undone.',
  deleteAllPartial: 'Deleted {deleted}, {failed} failed.',
  mutationFailed: 'The action did not complete. Try again.',
  titleLabel: 'Title',
  untitled: 'Untitled conversation',
  archivedAt: 'Archived',
  createdAt: 'Created',
  workspace: 'Workspace',
} satisfies Record<string, string>

/** Archive Tasks locale key union. */
export type ArchiveSettingsKey = keyof typeof en
