import fs from 'node:fs'
import path from 'node:path'

/** Fixed-shape evidence only. Engine stderr may contain secrets and is excluded. */
export function recordManagedExit(root: string, pid: number, code: number | null, signal: NodeJS.Signals | null): void {
  try {
    const dir = path.join(root, 'diagnostics')
    fs.mkdirSync(dir, {recursive: true})
    const file = path.join(dir, 'desktop-engine-exits.jsonl')
    if (fs.existsSync(file) && fs.statSync(file).size >= 256 * 1024) {
      const previous = path.join(dir, 'desktop-engine-exits.previous.jsonl')
      fs.rmSync(previous, {force: true})
      fs.renameSync(file, previous)
    }
    fs.appendFileSync(file, JSON.stringify({at: new Date().toISOString(), event: 'managed-engine-exit', pid, code, signal}) + '\n')
  } catch { /* diagnosis must not obstruct existing shutdown */ }
}
