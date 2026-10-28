/** Self-update orchestration for the plugin workspace (pull, install, rebuild). */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Wall-clock ceilings per step; a hung step aborts the update instead of blocking the host. */
const REV_TIMEOUT_MS = 30_000
const PULL_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 300_000
const BUILD_TIMEOUT_MS = 600_000

/** Locate the plugin workspace root: this module sits at
 * `<root>/packages/rollback-undo/<src|lib>/update.<ts|js>`, three levels below
 * the root under both the source and built layouts.
 * @returns Absolute path of the installable plugin workspace.
 * @throws When the expected marker file is absent (unexpected install layout).
 */
export function pluginWorkspaceRoot(): string {
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  if (!existsSync(resolve(candidate, 'pnpm-workspace.yaml'))) {
    throw new Error(`Cannot locate the plugin workspace root (expected ${candidate} to contain pnpm-workspace.yaml).`)
  }
  return candidate
}

/** Run one update step through the shell (pnpm resolves to pnpm.cmd on Windows).
 * @param cwd - Directory the command runs in.
 * @param command - Executable name without shell metacharacters.
 * @param args - Argument list without shell metacharacters.
 * @param timeoutMs - Kill the child after this long.
 * @returns The command's stdout.
 */
function run(cwd: string, command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(command, [...args], { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) {
        resolveResult(Buffer.concat(stdout).toString('utf8'))
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code}):${Buffer.concat(stderr).toString('utf8').trim()}`))
    })
  })
}

/** Outcome of one fast-forward pull. */
export interface PullOutcome {
  readonly before: string
  readonly after: string
  readonly changed: boolean
}

/** Fast-forward the workspace and report whether HEAD moved.
 * @param root - Plugin workspace root (a git checkout).
 * @returns HEAD ids before and after the pull.
 * @throws With git's stderr when the pull is rejected or the directory is not a checkout.
 */
export async function pullFastForward(root: string): Promise<PullOutcome> {
  const before = (await run(root, 'git', ['rev-parse', 'HEAD'], REV_TIMEOUT_MS)).trim()
  await run(root, 'git', ['pull', '--ff-only'], PULL_TIMEOUT_MS)
  const after = (await run(root, 'git', ['rev-parse', 'HEAD'], REV_TIMEOUT_MS)).trim()
  return { before, after, changed: after !== before }
}

/** Pull, install, and rebuild the plugin workspace in one transaction-shaped pass.
 * @param root - Plugin workspace root (a git checkout).
 * @returns User-facing summary text (already up to date, or updated and rebuilt).
 * @throws With a user-facing message at the first failing step.
 */
export async function performPluginUpdate(root: string): Promise<string> {
  let outcome: PullOutcome
  try {
    outcome = await pullFastForward(root)
  } catch (error) {
    throw new Error(`Update failed: pulling the latest code did not succeed (${root}).${error instanceof Error ? error.message : String(error)}`)
  }
  const range = `${outcome.before.slice(0, 7)}→${outcome.after.slice(0, 7)}`
  if (!outcome.changed) return `Already up to date (${outcome.after.slice(0, 7)}), nothing to update.`
  try {
    await run(root, 'pnpm', ['install'], INSTALL_TIMEOUT_MS)
  } catch (error) {
    throw new Error(`Pulled ${range}, but dependency installation failed; run pnpm install manually.${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await run(root, 'pnpm', ['run', 'build'], BUILD_TIMEOUT_MS)
  } catch (error) {
    throw new Error(`Pulled ${range}, but the build failed; run pnpm run build manually.${error instanceof Error ? error.message : String(error)}`)
  }
  return `Updated ${range} and rebuilt. Restart dsh for the new version to take effect.`
}
