/**
 * Build and pack this plugin for DeepSeek Harness, in one command:
 *
 *   npm run pack:plugin
 *
 * DeepSeek Harness manages its desktop profile itself ("managed exclusively by
 * the Electron application"), so the dsh CLI cannot add the plugin there. This
 * produces the tarball the app installs from; the app's profile already points
 * at this path, so the next install or update in the app picks up the new build.
 */
import { execSync } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(command) {
  process.stdout.write('\n$ ' + command + '\n')
  execSync(command, { cwd: root, stdio: 'inherit' })
}

for (const stale of readdirSync(root).filter(name => name.endsWith('.tgz'))) rmSync(resolve(root, stale))
run('npm run build')
run('npm pack')

const tarball = readdirSync(root).filter(name => name.endsWith('.tgz'))[0]
if (tarball === undefined) throw new Error('npm pack produced no tarball')
process.stdout.write('\nPacked ' + resolve(root, tarball) + '\n'
  + 'Install or update dsh-chrome-agent from that file in DeepSeek Harness, then restart the app.\n')
