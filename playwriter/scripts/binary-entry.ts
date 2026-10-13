/**
 * Entry point for the standalone `playwriter-recorder` binary built by
 * scripts/build-binary.ts with `bun build --compile`.
 *
 * In a compiled bun binary every bundled module reports
 * `import.meta.url === file:///$bunfs/root/<binary-name>`, so the source's
 * `path.join(__dirname, '..', 'dist', 'x.js')` style lookups resolve to
 * `/$bunfs/dist/x.js`, a path that does not exist. This wrapper embeds those
 * files at build time and serves them from memory through a small fs shim, so
 * the sources stay untouched and keep working under node/tsx.
 *
 * Only `/$bunfs/...` paths are intercepted; every other fs call is untouched.
 */

import fs from 'node:fs'
import path from 'node:path'

import packageJson from '../package.json' with { type: 'text' }
import a11yClient from '../dist/a11y-client.js' with { type: 'text' }
import bippy from '../dist/bippy.js' with { type: 'text' }
import ghostCursorClient from '../dist/ghost-cursor-client.js' with { type: 'text' }
import readability from '../dist/readability.js' with { type: 'text' }
import selectorGenerator from '../dist/selector-generator.js' with { type: 'text' }
import mcpPrompt from '../dist/prompt.md' with { type: 'text' }
import skill from '../src/skill.md' with { type: 'text' }

const BUNFS_PREFIX = '/$bunfs/'

// Keys are paths relative to the playwriter package root, which is what
// `/$bunfs` stands in for (modules live in `/$bunfs/root`, i.e. `src/` or `dist/`).
const embeddedFiles = new Map<string, string>([
  ['package.json', packageJson],
  ['dist/a11y-client.js', a11yClient],
  ['dist/bippy.js', bippy],
  ['dist/ghost-cursor-client.js', ghostCursorClient],
  ['dist/readability.js', readability],
  ['dist/selector-generator.js', selectorGenerator],
  ['dist/prompt.md', mcpPrompt],
  ['src/skill.md', skill],
])

function embeddedKey(target: fs.PathLike | number): string | undefined {
  if (typeof target !== 'string' || !target.startsWith(BUNFS_PREFIX)) {
    return undefined
  }
  const key = target.slice(BUNFS_PREFIX.length).split(path.sep).join('/')
  return embeddedFiles.has(key) ? key : undefined
}

const originalReadFileSync = fs.readFileSync
const originalExistsSync = fs.existsSync

fs.readFileSync = function readFileSync(target: any, options?: any) {
  const key = embeddedKey(target)
  if (key === undefined) {
    return originalReadFileSync.call(fs, target, options)
  }
  const content = embeddedFiles.get(key)!
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding ? content : Buffer.from(content, 'utf-8')
} as typeof fs.readFileSync

fs.existsSync = function existsSync(target: fs.PathLike) {
  return embeddedKey(target) !== undefined || originalExistsSync.call(fs, target)
}

// The bundled extension ships next to the binary. package-paths.ts reads this
// env var first; the host app can still override it.
const execDir = path.dirname(process.execPath)
if (!process.env.PLAYWRITER_EXTENSION_PATH) {
  const sidecarExtension = path.join(execDir, 'extension')
  if (originalExistsSync.call(fs, path.join(sidecarExtension, 'manifest.json'))) {
    process.env.PLAYWRITER_EXTENSION_PATH = sidecarExtension
  }
}

// relay-client.ts starts the relay daemon with
// `spawn(process.execPath, ['<dir>/start-relay-server.js'])`. In the binary
// process.execPath is this executable, so route that invocation to the relay
// server module instead of the CLI parser.
const daemonScript = process.argv[2]
if (daemonScript && /[\\/]start-relay-server\.(js|ts)$/.test(daemonScript)) {
  process.argv.splice(2, 1)
  await import('../src/start-relay-server.ts')
} else {
  await import('../src/cli.ts')
}
