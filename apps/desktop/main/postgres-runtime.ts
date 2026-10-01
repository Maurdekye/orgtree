import fs from 'node:fs'
import path from 'node:path'

/** Installed apps always use bundled paths and may bootstrap a fresh root.
 * A developer's path opt-in alone must never enable first-run initialization. */
export function postgresLaunchOptions(packaged: boolean, env: NodeJS.ProcessEnv) {
  return { packagedPostgres: packaged || env.ORGTREE_DESKTOP_PACKAGED_PG === '1', bootstrapPostgres: packaged }
}

export function writeEnginePaths(file: string, options: { directory: string; python: string; dataRoot: string }) {
  const locations = postgresRuntimeEnvironment(options.directory, true)
  const importer = path.resolve(options.directory, '..', 'tools', 'pypg', 'pgimport.py')
  for (const target of [options.python, importer]) {
    if (!path.isAbsolute(target) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw new Error(`Packaged engine file is missing: ${target}`)
  }
  if (!path.isAbsolute(options.dataRoot)) throw new Error('Engine data root must be absolute')
  const descriptor = { schema: 'orgtree.engine-paths/v1', engine: options.directory,
    python: options.python, data: options.dataRoot, custodian: locations.ORGTREE_PG_CUSTODIAN,
    pgBin: locations.ORGTREE_P03_PG_BIN, importer }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(descriptor, null, 2) + '\n')
  fs.renameSync(file + '.tmp', file)
}

/** Supply executable locations only. PG-1 owns backend selection from the
 * cutover record and creates connection details after validating the cluster.
 * Development builds can opt in to paths without enabling bootstrap. */
export function postgresRuntimeEnvironment(directory: string, enabled = false): NodeJS.ProcessEnv {
  if (!enabled) return {}
  if (!path.isAbsolute(directory)) throw new Error('Packaged PostgreSQL requires an absolute engine directory')
  const custodian = path.join(directory, 'pg-custodian.exe')
  const bin = path.join(directory, 'postgresql', 'bin')
  // Keep this aligned with PgBin::locate in pg-custodian/src/cluster.rs.
  const tools = ['postgres.exe', 'pg_ctl.exe', 'initdb.exe', 'psql.exe', 'pg_controldata.exe']
  for (const file of [custodian, ...tools.map(name => path.join(bin, name))]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Packaged PostgreSQL executable is missing: ${file}`)
    }
  }
  return { ORGTREE_PG_CUSTODIAN: custodian, ORGTREE_P03_PG_BIN: bin }
}
