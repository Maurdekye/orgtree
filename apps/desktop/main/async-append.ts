/** ASYNC LOG APPENDS (@item:orgtree/nick-pc-4-6-0-desktop-main-process-stalls-input-f item 6). The stall log and the
 *  window-events log wrote each line with mkdirSync/statSync/renameSync/appendFileSync on the main thread, inside every
 *  stall record and window event: usually under 5 ms, far more on a slow or antivirus-scanned disk, and a stall record
 *  is written exactly when the machine is slow. Here each line is queued per file and written in order off the main
 *  thread, with the same size rotation. A failure drops that line only; diagnostics never break what they describe. */
import fs from 'node:fs'
import path from 'node:path'

const chains = new Map<string, Promise<void>>()

/** Append `text` to `file` after every earlier append to it. When the file is already over `maxBytes` it is renamed
 *  to `.1` first (keep 2: the old `.1` becomes `.2`, the old `.2` is removed). */
export function appendRotating(file: string, text: string, maxBytes: number, keep: 1 | 2): void {
  const next = (chains.get(file) ?? Promise.resolve()).then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    let size = 0
    try { size = (await fs.promises.stat(file)).size } catch { /* not there yet */ }
    if (size > maxBytes) {
      if (keep === 2) {
        try { await fs.promises.rm(file + '.2', { force: true }) } catch { /* best effort */ }
        try { await fs.promises.rename(file + '.1', file + '.2') } catch { /* no .1 yet */ }
      }
      await fs.promises.rename(file, file + '.1')
    }
    await fs.promises.appendFile(file, text)
  }).catch(() => { /* this line is lost; the next one tries again */ })
  chains.set(file, next)
  void next.then(() => { if (chains.get(file) === next) chains.delete(file) })
}

/** Settles when every append queued so far has been written (tests, and anything that reads its own log back). */
export function flushAppends(): Promise<void> {
  return Promise.all([...chains.values()]).then(() => undefined)
}
