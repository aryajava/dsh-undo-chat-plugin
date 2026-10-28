import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert for the rollback-undo/rollback-archive
 * Remote artifacts. The Client pass selects packages that declare a browser
 * bundle and lets their package-local configs emit both their Node loader
 * entry and browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    // The vendored typert protocol ships its upstream build verbatim, so it has
    // no TypeScript entry to bundle; keep it out of both build faces.
    workspace: {
      include: ['packages/*'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/test?(s)/**', '**/t?(e)mp/**', 'packages/typert-protocol'],
    },
    entry: client ? '' : ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
