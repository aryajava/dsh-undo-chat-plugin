/**
 * Analysis shim over the vendored 0.2.1 protocol build.
 *
 * The typert generator only accepts a `@Remote` decorator whose declaration
 * lives inside a workspace-registered package, so this package re-exports the
 * published protocol types through its own root. Runtime imports stay external
 * and resolve to the copy the desktop harness ships.
 *
 * The `@deepseek-ai/cordis` augmentation lives in a separate file pulled in by
 * this reference instead of an import: `FaceAnalyzer` treats a package whose
 * entry files declare a non-empty `Context` or `Events` augmentation as a
 * Cordis-service contributor and then tries to model the protocol's own
 * generic declarations, which cannot be represented as Typert artifacts.
 * @module @deepseek-ai/dsh-typert-protocol
 */
/// <reference path="../vendor/types/cordis-augment.d.ts" />
export * from '../vendor/types/index.js'
