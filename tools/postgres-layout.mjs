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
