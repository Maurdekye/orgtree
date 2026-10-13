import fs from 'node:fs'
import path from 'node:path'
import type {CoreControlFailure} from './core-lifecycle'

/** Fixed-shape evidence only. Engine stderr may contain secrets and is excluded. */
function append(root: string, record: object): void {
  try {
    const dir = path.join(root, 'diagnostics')
    fs.mkdirSync(dir, {recursive: true})
    const file = path.join(dir, 'desktop-engine-exits.jsonl')
    if (fs.existsSync(file) && fs.statSync(file).size >= 256 * 1024) {
      const previous = path.join(dir, 'desktop-engine-exits.previous.jsonl')
      fs.rmSync(previous, {force: true})
      fs.renameSync(file, previous)
    }
    fs.appendFileSync(file, JSON.stringify({at: new Date().toISOString(), ...record}) + '\n')
  } catch { /* diagnosis must not obstruct existing shutdown */ }
}

export function recordManagedExit(root: string, pid: number, code: number | null, signal: NodeJS.Signals | null): void {
  append(root, {event: 'managed-engine-exit', pid, code, signal})
}

/** Why a native lifecycle command failed (core-lifecycle.ts builds the fixed
 *  shape), so a refused launch or recovery control can be explained later. */
export function recordCoreControlFailure(root: string, failure: CoreControlFailure): void {
  append(root, failure)
}
