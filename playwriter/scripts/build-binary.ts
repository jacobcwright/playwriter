/**
 * Builds the standalone `playwriter-recorder` executable (CLI + relay daemon)
 * with `bun build --compile`, so a host app can ship it without Node installed.
 *
 * Output: playwriter/dist-bin/
 *   playwriter-recorder    the executable (entry: scripts/binary-entry.ts)
 *   recorder-prompt.md     sidecar read by `recorder start` (see cli.ts)
 *   extension/             copy of ../extension/dist (PLAYWRITER_EXTENSION_PATH)
 *
 * Usage: bun scripts/build-binary.ts [--target bun-darwin-arm64]
 * Requires `pnpm build` (dist/ client bundles) and a built extension/dist.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const playwriterDir = path.join(__dirname, '..')
const distDir = path.join(playwriterDir, 'dist')
const srcDir = path.join(playwriterDir, 'src')
const extensionDistDir = path.join(playwriterDir, '..', 'extension', 'dist')
const outDir = path.join(playwriterDir, 'dist-bin')
const binaryName = 'playwriter-recorder'

const BUILT_INPUTS = [
  'a11y-client.js',
  'bippy.js',
  'ghost-cursor-client.js',
  'readability.js',
  'selector-generator.js',
  'prompt.md',
].map((name) => path.join(distDir, name))

// Native/optional deps that cannot live inside a single executable. Both are
// loaded with a guarded dynamic import, so leaving them out is safe.
const EXTERNALS = ['sharp', '@playwriter/patchright-core']

function parseTarget(): string | undefined {
  const args = process.argv.slice(2)
  const index = args.findIndex((arg) => arg === '--target' || arg.startsWith('--target='))
  if (index === -1) {
    return undefined
  }
  const inline = args[index].split('=')[1]
  return inline || args[index + 1]
}

function assertExists(filePath: string, hint: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. ${hint}`)
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function main() {
  for (const input of BUILT_INPUTS) {
    assertExists(input, 'Run `pnpm build` in playwriter/ first.')
  }
  assertExists(path.join(extensionDistDir, 'manifest.json'), 'Run `pnpm build` in extension/ first.')
  assertExists(path.join(srcDir, 'recorder-prompt.md'), 'recorder-prompt.md is part of the source tree.')

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const outfile = path.join(outDir, process.platform === 'win32' ? `${binaryName}.exe` : binaryName)
  const target = parseTarget()
  const args = [
    'build',
    '--compile',
    ...(target ? ['--target', target] : []),
    ...EXTERNALS.flatMap((name) => ['--external', name]),
    path.join(__dirname, 'binary-entry.ts'),
    '--outfile',
    outfile,
  ]
  console.log(`bun ${args.join(' ')}`)
  execFileSync(process.env.BUN_BIN || 'bun', args, { cwd: playwriterDir, stdio: 'inherit' })

  fs.copyFileSync(path.join(srcDir, 'recorder-prompt.md'), path.join(outDir, 'recorder-prompt.md'))
  fs.cpSync(extensionDistDir, path.join(outDir, 'extension'), { recursive: true })

  console.log('')
  console.log(`Built ${outfile} (${formatMb(fs.statSync(outfile).size)})`)
  console.log(`  + ${path.join(outDir, 'recorder-prompt.md')}`)
  console.log(`  + ${path.join(outDir, 'extension')} (${JSON.parse(fs.readFileSync(path.join(extensionDistDir, 'manifest.json'), 'utf-8')).version})`)
}

main()
