/**
 * Build, pack and install this plugin into a DSH profile, in one command:
 *
 *   node scripts/install-profile.mjs [profileName]     # defaults to web
 *
 * A tarball install rather than a directory link: pnpm mis-creates the
 * node_modules junction for a cross-drive local dependency in this profile
 * layout, so the launcher cannot read the package manifest and never adds the
 * bundle (see dsh-run-in-terminal's README for the full diagnosis).
 */
import { execSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.argv[2] ?? 'web'

function run(command) {
  process.stdout.write('\n$ ' + command + '\n')
  execSync(command, { cwd: root, stdio: 'inherit' })
}

function runQuietly(command) {
  try { run(command) } catch { process.stdout.write('(' + command + ' exited non-zero; continuing)\n') }
}

for (const stale of readdirSync(root).filter(name => name.endsWith('.tgz'))) rmSync(resolve(root, stale))
run('npm run build')
run('npm pack')

const tarball = readdirSync(root).filter(name => name.endsWith('.tgz'))[0]
if (tarball === undefined) throw new Error('npm pack produced no tarball')
const spec = 'file:' + resolve(root, tarball).replace(/\\/g, '/')

runQuietly('dsh plugin --profile ' + profile + ' remove dsh-chrome-agent')
run('dsh plugin --profile ' + profile + ' add "' + spec + '"')
process.stdout.write('\nRestart the DSH server for this profile, then reload the page.\n')
