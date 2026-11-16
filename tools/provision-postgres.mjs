// Assemble the Windows PostgreSQL payload at build time; never start a cluster.
// (Ported from tools/provision-postgres.py, 4.6.1.)
//
// Downloads the pinned vendor archive (or accepts --archive for an offline
// cache), extracts only bin/lib/share and the redistribution notices into
// engine/postgresql, and writes engine/postgres-runtime-manifest.json (schema
// v2). No installer, Windows service, registry or application data is
// accessed.
//
// 4.6.1 ALSO DROPS pg-custodian.exe. The Rust engine runs PostgreSQL directly
// (pg.rs) and nothing reads the custodian, so it is neither built nor
// recorded any more, and the v2 manifest has no `custodian` section.
//
//   node tools/provision-postgres.mjs [--archive <pinned zip>]
//   node tools/provision-postgres.mjs --rewrite-manifest
//
// --rewrite-manifest turns an existing, already-provisioned v1 payload into v2
// without re-downloading 380 MB. It verifies every engine/postgresql file
// against the v1 manifest's own records first and refuses on any difference.
//
// ⚠ LINKS. The Python version read FILE_ATTRIBUTE_REPARSE_POINT from lstat.
// Node's lstat has no attributes; on Windows it reports junctions and symlinks
// as symbolic links, which is what is refused here. Other reparse tags (cloud
// placeholders, dedup) are not visible to Node and read as ordinary entries.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'postgres-runtime-pin.json'), 'utf8'))
export const NOTICES = ['server_license.txt', 'commandlinetools_3rd_party_licenses.txt']
export const TOOLS = ['postgres.exe', 'pg_ctl.exe', 'initdb.exe', 'psql.exe', 'pg_controldata.exe']
export const SCHEMA = 'orgtree.postgres-runtime/v2'

export function sha256(file) {
  const digest = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const block = Buffer.alloc(1024 * 1024)
    for (let read; (read = fs.readSync(fd, block, 0, block.length, null)) > 0;) digest.update(block.subarray(0, read))
  } finally { fs.closeSync(fd) }
  return digest.digest('hex')
}

export function noLinks(target) {
  for (let entry = path.resolve(target); ;) {
    if (fs.lstatSync(entry).isSymbolicLink()) throw new Error(`Linked payload entry: ${entry}`)
    const parent = path.dirname(entry)
    if (parent === entry) return
    entry = parent
  }
}

function regular(file) {
  let info
  try { info = fs.lstatSync(file) } catch { info = null }
  if (!info || !info.isFile()) throw new Error(`Expected regular file without links: ${file}`)
  noLinks(file)
}

/** Validate BEFORE selecting: no drive, UNC, backslash, traversal or ADS. */
export function selectedMember(name) {
  const parts = name.split('/').filter(part => part !== '' && part !== '.')
  if (name.includes('\\') || name.includes(':') || name.startsWith('/') || parts.includes('..')) throw new Error(`Unsafe archive member: ${name}`)
  if (parts.length < 2 || parts[0] !== 'pgsql') return null
  const relative = parts.slice(1).join('/')
  if (['bin', 'lib', 'share'].includes(parts[1]) || NOTICES.includes(relative)) return relative
  return null
}

// ---------------------------------------------------------------- ZIP reading
// Just what this archive needs: the central directory (with Zip64 sizes and
// offsets), stored and deflated members, CRC-32 checked like Python's zipfile.

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const read = fs.readSync(fd, buffer, done, length - done, position + done)
    if (read <= 0) throw new Error('Truncated ZIP archive')
    done += read
  }
  return buffer
}

export function zipEntries(fd) {
  const size = fs.fstatSync(fd).size
  const tailLength = Math.min(size, 65557)
  const tail = readAt(fd, size - tailLength, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('Not a ZIP archive (no end of central directory)')
  let count = tail.readUInt16LE(eocd + 10), dirSize = tail.readUInt32LE(eocd + 12), dirOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error('Zip64 archive without a Zip64 locator')
    const record = readAt(fd, Number(tail.readBigUInt64LE(locator + 8)), 56)
    if (record.readUInt32LE(0) !== 0x06064b50) throw new Error('Bad Zip64 end of central directory')
    count = Number(record.readBigUInt64LE(32)); dirSize = Number(record.readBigUInt64LE(40)); dirOffset = Number(record.readBigUInt64LE(48))
  }
  const directory = readAt(fd, dirOffset, dirSize)
  const entries = []
  for (let at = 0, n = 0; n < count; n++) {
    if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error('Bad ZIP central directory entry')
    const madeBy = directory.readUInt16LE(at + 4), flags = directory.readUInt16LE(at + 8), method = directory.readUInt16LE(at + 10)
    const crc = directory.readUInt32LE(at + 16)
    let compressed = directory.readUInt32LE(at + 20), uncompressed = directory.readUInt32LE(at + 24)
    const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32)
    const external = directory.readUInt32LE(at + 38)
    let offset = directory.readUInt32LE(at + 42)
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1')
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e), length = extra.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let f = e + 4
        if (uncompressed === 0xffffffff) { uncompressed = Number(extra.readBigUInt64LE(f)); f += 8 }
        if (compressed === 0xffffffff) { compressed = Number(extra.readBigUInt64LE(f)); f += 8 }
        if (offset === 0xffffffff) { offset = Number(extra.readBigUInt64LE(f)); f += 8 }
      }
      e += 4 + length
    }
    entries.push({ name, madeBy, flags, method, crc, compressed, uncompressed, external, offset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export function zipRead(fd, entry) {
  const local = readAt(fd, entry.offset, 30)
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad ZIP local header: ${entry.name}`)
  const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  const raw = readAt(fd, start, entry.compressed)
  const data = entry.method === 0 ? raw : entry.method === 8 ? zlib.inflateRawSync(raw) : null
  if (!data) throw new Error(`Unsupported ZIP compression ${entry.method}: ${entry.name}`)
  if (data.length !== entry.uncompressed || zlib.crc32(data) !== entry.crc) throw new Error(`Bad CRC-32 for file ${entry.name}`)
  return data
}

const isLink = entry => ((entry.external >>> 16) & 0o170000) === 0o120000

export function extractRuntime(archive, destination) {
  const seen = new Set()
  const fd = fs.openSync(archive, 'r')
  try {
    for (const entry of zipEntries(fd)) {
      const relative = selectedMember(entry.name)
      if (relative === null || entry.name.endsWith('/')) continue
      if (seen.has(relative.toLowerCase()) || isLink(entry)) throw new Error(`Duplicate or linked archive member: ${entry.name}`)
      seen.add(relative.toLowerCase())
      const target = path.join(destination, ...relative.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, zipRead(fd, entry), { flag: 'wx' })
    }
  } finally { fs.closeSync(fd) }
  for (const relative of [...TOOLS.map(tool => `bin/${tool}`), ...NOTICES, 'share/postgres.bki']) regular(path.join(destination, relative))
  let lib
  try { lib = fs.lstatSync(path.join(destination, 'lib')) } catch { lib = null }
  if (!lib || !lib.isDirectory()) throw new Error('PostgreSQL lib directory missing')
}

/** Every file under `directory`, sorted case-insensitively by path, with size
 *  and SHA-256; refuses links. */
export function files(directory) {
  const found = []
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      noLinks(full)
      if (entry.isDirectory()) walk(full, prefix + entry.name + '/')
      else if (entry.isFile()) found.push(prefix + entry.name)
    }
  }
  walk(directory, '')
  found.sort((a, b) => {
    const x = a.toLowerCase().split('/'), y = b.toLowerCase().split('/')
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return x.length - y.length
  })
  const result = {}
  for (const name of found) {
    const full = path.join(directory, ...name.split('/'))
    result[name] = { bytes: fs.statSync(full).size, sha256: sha256(full) }
  }
  return result
}

const sameRecords = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

function writeManifest(engine, records) {
  const manifest = { schema: SCHEMA, archive: PIN, files: Object.fromEntries(Object.entries(records).map(([name, value]) => [`postgresql/${name}`, value])) }
  const target = path.join(engine, 'postgres-runtime-manifest.json')
  fs.writeFileSync(target + '.tmp', JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  fs.renameSync(target + '.tmp', target)
  const entries = Object.values(manifest.files)
  return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), manifest: target }
}

export function assemble(archive, { root = ROOT } = {}) {
  regular(archive)
  if (fs.statSync(archive).size !== PIN.bytes || sha256(archive) !== PIN.sha256) throw new Error('PostgreSQL archive size/SHA-256 differs from the pin')
  const engine = path.join(root, 'engine')
  noLinks(engine)
  const artifacts = path.join(root, 'artifacts', 'postgres-provision')
  fs.mkdirSync(artifacts, { recursive: true })
  const temp = fs.mkdtempSync(path.join(artifacts, 'payload-'))
  try {
    const stage = path.join(temp, 'postgresql')
    fs.mkdirSync(stage)
    extractRuntime(archive, stage)
    const records = files(stage)
    const destination = path.join(engine, 'postgresql')
    if (fs.existsSync(destination)) {
      // Never silently repair or merge a contaminated payload.
      if (!sameRecords(files(destination), records)) throw new Error(`Existing payload differs; remove explicitly before reprovisioning: ${destination}`)
    } else {
      fs.renameSync(stage, destination)
    }
    return writeManifest(engine, records)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

/** v1 -> v2 in place, from a payload that still matches its v1 records. */
export function rewriteManifest({ root = ROOT } = {}) {
  const engine = path.join(root, 'engine')
  const file = path.join(engine, 'postgres-runtime-manifest.json')
  regular(file)
  const old = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (old.schema === SCHEMA) return { unchanged: true, manifest: file }
  if (old.schema !== 'orgtree.postgres-runtime/v1') throw new Error(`Unknown manifest schema: ${old.schema}`)
  if (Object.keys(PIN).some(key => old.archive?.[key] !== PIN[key])) throw new Error('The v1 manifest names a different archive than the pin; reprovision')
  const recorded = Object.fromEntries(Object.entries(old.files ?? {}).filter(([name]) => name.startsWith('postgresql/')).map(([name, value]) => [name.slice('postgresql/'.length), value]))
  const actual = files(path.join(engine, 'postgresql'))
  if (!sameRecords(actual, recorded)) throw new Error('engine/postgresql differs from its v1 manifest; remove it and reprovision')
  return writeManifest(engine, actual)
}

async function download(archive) {
  const part = archive + '.part'
  const response = await fetch(PIN.url, { signal: AbortSignal.timeout(600000) })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  const out = fs.createWriteStream(part)
  for await (const chunk of response.body) if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
  await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()))
  if (fs.statSync(part).size !== PIN.bytes || sha256(part) !== PIN.sha256) throw new Error('Downloaded PostgreSQL archive does not match pin')
  fs.renameSync(part, archive)
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node tools/provision-postgres.mjs [--archive <pinned zip>] | --rewrite-manifest')
    return 0
  }
  if (process.platform !== 'win32') throw new Error('Windows x64 build host required')
  if (argv.includes('--rewrite-manifest')) {
    console.log(JSON.stringify(rewriteManifest(), null, 2))
    return 0
  }
  const at = argv.indexOf('--archive')
  let archive = at >= 0 ? argv[at + 1] : null
  if (at >= 0 && !archive) throw new Error('--archive needs a path')
  if (!archive) {
    const cache = path.join(ROOT, '.runtime-cache')
    fs.mkdirSync(cache, { recursive: true })
    archive = path.join(cache, `postgresql-${PIN.version}-windows-x64-binaries.zip`)
    if (!fs.existsSync(archive)) await download(archive)
  }
  console.log(JSON.stringify(assemble(path.resolve(archive)), null, 2))
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }, error => { console.error(error.message); process.exitCode = 1 })
}
