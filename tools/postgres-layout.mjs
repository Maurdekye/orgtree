import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const POSTGRES_PIN = JSON.parse(fs.readFileSync(new URL('./postgres-runtime-pin.json', import.meta.url), 'utf8'))
export const POSTGRES_REQUIRED = ['pg-custodian.exe',
  ...['postgres.exe', 'pg_ctl.exe', 'initdb.exe', 'psql.exe', 'pg_controldata.exe'].map(file => `postgresql/bin/${file}`),
  'postgresql/share/postgres.bki', 'postgresql/server_license.txt', 'postgresql/commandlinetools_3rd_party_licenses.txt']
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function regular(file) {
  if (!fs.lstatSync(file).isFile()) {
    throw new Error(`PostgreSQL payload must contain regular files without links: ${file}`)
  }
  for (let current = path.resolve(file); ;) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked PostgreSQL payload path: ${current}`)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

function walk(directory, prefix = '') {
  const result = []
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Linked or missing PostgreSQL directory: ${directory}`)
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name
    if (entry.isDirectory()) result.push(...walk(path.join(directory, entry.name), relative + '/'))
    else { regular(path.join(directory, entry.name)); result.push(relative) }
  }
  return result
}

/** Read-only package gate: validate every byte and (for a source checkout)
 * reject a custodian compiled from older Rust sources. No executable is run. */
export function assertPostgresRuntime(engineDirectory, { sourceRoot } = {}) {
  const manifestFile = path.join(engineDirectory, 'postgres-runtime-manifest.json')
  regular(manifestFile)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.schema !== 'orgtree.postgres-runtime/v1'
      || Object.keys(POSTGRES_PIN).some(key => manifest.archive?.[key] !== POSTGRES_PIN[key])
      || !Array.isArray(manifest.custodian?.features) || manifest.custodian.features.length !== 0) {
    throw new Error('PostgreSQL runtime manifest has an unapproved archive or custodian feature set')
  }
  const records = manifest.files
  if (!records || typeof records !== 'object' || Array.isArray(records)
      || POSTGRES_REQUIRED.some(file => !Object.hasOwn(records, file))) throw new Error('PostgreSQL runtime manifest is incomplete')
  const actual = ['pg-custodian.exe', ...walk(path.join(engineDirectory, 'postgresql'), 'postgresql/')].sort()
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(records).sort())) throw new Error('PostgreSQL runtime file set differs from manifest')
  let bytes = 0
  for (const file of actual) {
    const full = path.join(engineDirectory, file)
    regular(full)
    const data = fs.readFileSync(full)
    if (data.length !== records[file].bytes || hash(data) !== records[file].sha256) throw new Error(`PostgreSQL runtime hash mismatch: ${file}`)
    bytes += data.length
  }
  if (sourceRoot) {
    const names = execFileSync('git', ['ls-files', '--', 'engine/native'], { cwd: sourceRoot, encoding: 'utf8' }).trim().split(/\r?\n/)
    const sources = manifest.custodian.sources
    if (!sources || !names.length || JSON.stringify(names.sort()) !== JSON.stringify(Object.keys(sources).sort())) {
      throw new Error('Custodian source list changed; run npm run postgres:provision')
    }
    for (const name of names) {
      if (hash(fs.readFileSync(path.join(sourceRoot, name))) !== sources[name]) throw new Error(`Custodian source changed: ${name}; run npm run postgres:provision`)
    }
  }
  return { files: actual.length, bytes, manifestSha256: hash(fs.readFileSync(manifestFile)) }
}

/** The MSVC toolset that linked a Windows binary, as [major, minor], read from
 * its PE optional header; null for anything else (a non-PE file, or a binary
 * linked by another toolchain such as MinGW's 2.x). */
export function msvcLinkerVersion(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return null
  const pe = bytes.readUInt32LE(0x3c)
  if (pe + 26 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) return null
  const major = bytes[pe + 26], minor = bytes[pe + 27]
  return major === 14 ? [major, minor] : null
}

/** The oldest Microsoft Visual C++ runtime Setup accepts, as [major, minor]:
 * the one number tools/vc-runtime.ps1 holds. */
export function vcRuntimeMinimum(source = fs.readFileSync(new URL('./vc-runtime.ps1', import.meta.url), 'utf8')) {
  const found = source.match(/^\$script:VcRuntimeMinimum=\[version\]'(\d+)\.(\d+)\.0\.0'\r?$/m)
  if (!found) throw new Error('tools/vc-runtime.ps1 no longer states $script:VcRuntimeMinimum')
  return [Number(found[1]), Number(found[2])]
}

/** Read-only package gate: Microsoft supports a runtime only when it is at
 * least as new as the toolset that built the program, and the PostgreSQL
 * payload ships no runtime of its own. A payload built by a newer toolset than
 * Setup's minimum would install on a PC where the database cannot start, which
 * is the reported failure, so the package is refused until the minimum in
 * tools/vc-runtime.ps1 is raised. No executable is run. */
export function assertVcRuntimeMinimum(engineDirectory, minimum = vcRuntimeMinimum()) {
  let newest = null, from = null, binaries = 0
  for (const file of walk(path.join(engineDirectory, 'postgresql'), 'postgresql/')) {
    if (!/\.(exe|dll)$/i.test(file)) continue
    const version = msvcLinkerVersion(fs.readFileSync(path.join(engineDirectory, file)))
    if (!version) continue
    binaries++
    if (!newest || version[0] > newest[0] || (version[0] === newest[0] && version[1] > newest[1])) { newest = version; from = file }
  }
  if (newest && (newest[0] > minimum[0] || (newest[0] === minimum[0] && newest[1] > minimum[1]))) {
    throw new Error(`PostgreSQL payload needs Visual C++ runtime ${newest.join('.')} (${from}), newer than Setup's minimum ${minimum.join('.')}; raise $script:VcRuntimeMinimum in tools/vc-runtime.ps1`)
  }
  return { binaries, newest: newest ? newest.join('.') : null, minimum: minimum.join('.') }
}
