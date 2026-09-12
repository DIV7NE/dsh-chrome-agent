/**
 * Build the Chrome Web Store upload zip.
 *
 * The store takes one zip whose *root* is the extension — manifest.json at the
 * top level, not inside a folder. Everything the store does not want (sources,
 * tests, node_modules, store art) is left out, so the uploaded artifact is
 * exactly what Chrome will run.
 *
 *   npm run pack:webstore
 */
import { createWriteStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extDir = join(root, 'extension')
const out = join(root, 'dsh-chrome-agent-webstore.zip')

/** Every file under `extension/`, as paths relative to it. */
async function walk(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await walk(full))
    else found.push(relative(extDir, full).split(sep).join('/'))
  }
  return found
}

// --- minimal ZIP writer (store takes deflate; no dependency needed) ---
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const files = (await walk(extDir)).sort()
const entries = []
for (const name of files) {
  const data = await readFile(join(extDir, name))
  entries.push({ name, data, deflated: deflateRawSync(data, { level: 9 }), crc: crc32(data) })
}

const chunks = []
const central = []
let offset = 0
for (const e of entries) {
  const nameBuf = Buffer.from(e.name, 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8)          // deflate
  local.writeUInt16LE(0, 10)         // time
  local.writeUInt16LE(0x21, 12)      // date (1980-01-01)
  local.writeUInt32LE(e.crc, 14)
  local.writeUInt32LE(e.deflated.length, 18)
  local.writeUInt32LE(e.data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  chunks.push(local, nameBuf, e.deflated)

  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(20, 4)
  cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(0, 8)
  cd.writeUInt16LE(8, 10)
  cd.writeUInt16LE(0, 12)
  cd.writeUInt16LE(0x21, 14)
  cd.writeUInt32LE(e.crc, 16)
  cd.writeUInt32LE(e.deflated.length, 20)
  cd.writeUInt32LE(e.data.length, 24)
  cd.writeUInt16LE(nameBuf.length, 28)
  cd.writeUInt16LE(0, 30)
  cd.writeUInt16LE(0, 32)
  cd.writeUInt16LE(0, 34)
  cd.writeUInt16LE(0, 36)
  cd.writeUInt32LE(0, 38)
  cd.writeUInt32LE(offset, 42)
  central.push(cd, nameBuf)
  offset += local.length + nameBuf.length + e.deflated.length
}
const centralBuf = Buffer.concat(central)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(entries.length, 8)
end.writeUInt16LE(entries.length, 10)
end.writeUInt32LE(centralBuf.length, 12)
end.writeUInt32LE(offset, 16)
end.writeUInt16LE(0, 20)

await new Promise((ok, bad) => {
  const ws = createWriteStream(out)
  ws.on('error', bad)
  ws.on('close', ok)
  ws.write(Buffer.concat(chunks))
  ws.write(centralBuf)
  ws.write(end)
  ws.end()
})

const total = (await stat(out)).size
console.log('wrote ' + relative(root, out) + ' (' + entries.length + ' files, ' + total + ' bytes)')
for (const e of entries) console.log('  ' + e.name)
