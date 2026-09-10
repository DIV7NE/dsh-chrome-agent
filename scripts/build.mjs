/**
 * Build the host half with esbuild. The extension is plain JS and needs no
 * build step — Chrome loads extension/ exactly as it sits on disk.
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = resolve(root, 'lib')

await rm(lib, { recursive: true, force: true })
await mkdir(lib, { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(lib, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['ws', '@deepseek-ai/dsh-tools'],
  logLevel: 'info',
})
