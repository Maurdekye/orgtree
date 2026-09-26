import fs from 'node:fs'
import path from 'node:path'

/** Supply executable locations only. PG-1 owns backend selection from the
 * cutover record and creates connection details after validating the cluster.
 * Disabled until the packaged runtime is explicitly enabled by the operator. */
export function postgresRuntimeEnvironment(directory: string, enabled = false): NodeJS.ProcessEnv {
  if (!enabled) return {}
  if (!path.isAbsolute(directory)) throw new Error('Packaged PostgreSQL requires an absolute engine directory')
  const custodian = path.join(directory, 'pg-custodian.exe')
  const bin = path.join(directory, 'postgresql', 'bin')
  for (const file of [custodian, ...['postgres.exe', 'pg_ctl.exe', 'initdb.exe'].map(name => path.join(bin, name))]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Packaged PostgreSQL executable is missing: ${file}`)
    }
  }
  return { ORGTREE_PG_CUSTODIAN: custodian, ORGTREE_P03_PG_BIN: bin }
}
