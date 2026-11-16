import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PREFERENCES, preferencesPatch } from './policy'
import type { DesktopPreferences } from '../../../packages/contracts/index'
import { notificationPreferences } from '../../../packages/contracts/notifications'

export class Preferences {
  private value: DesktopPreferences
  constructor(private file: string) {
    this.value = { ...DEFAULT_PREFERENCES }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      const patch = preferencesPatch(raw)
      if (!Object.prototype.hasOwnProperty.call(patch, 'visualThemeExplicit')
          && Object.prototype.hasOwnProperty.call(patch, 'visualTheme')) {
        // A stored theme without provenance predates the marker and is an explicit user choice.
        patch.visualThemeExplicit = true
      }
      this.value = { ...this.value, ...patch, ...notificationPreferences(patch) }
    } catch { /* Missing/corrupt settings use documented defaults. */ }
  }
  get(): DesktopPreferences { return { ...this.value } }
  set(patch: unknown): DesktopPreferences {
    const normalized = preferencesPatch(patch)
    // Filter state is patched one org/surface at a time by multiple windows.
    // Merge from this live copy so a stale window cannot erase another org's
    // value or a concurrent surface update.
    const activeAgentsByOrg = normalized.activeAgentsByOrg
    delete normalized.activeAgentsByOrg
    if (activeAgentsByOrg) {
      const merged = new Map(Object.entries(this.value.activeAgentsByOrg ?? {}))
      for (const [slug, value] of Object.entries(activeAgentsByOrg)) {
        merged.set(slug, { ...merged.get(slug), ...value })
      }
      normalized.activeAgentsByOrg = Object.fromEntries([...merged.entries()].slice(-200))
    }
    // The view lists are changed one org at a time from the live copy, never
    // replaced from a window's older snapshot (that erased other windows' records).
    const orgView = normalized.orgView
    delete normalized.orgView
    delete normalized.attentionOrgs
    delete normalized.canvasOrgs
    if (orgView) {
      const rest = (l: string[] | undefined) => (l ?? []).filter(s => s !== orgView.slug)
      const add = (l: string[]) => [...l, orgView.slug].slice(-200)
      normalized.attentionOrgs = orgView.view === 'attention' ? add(rest(this.value.attentionOrgs)) : rest(this.value.attentionOrgs)
      normalized.canvasOrgs = orgView.view === 'canvas' ? add(rest(this.value.canvasOrgs)) : rest(this.value.canvasOrgs)
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'visualTheme')
        && !Object.prototype.hasOwnProperty.call(normalized, 'visualThemeExplicit')) {
      normalized.visualThemeExplicit = true
    }
    this.value = { ...this.value, ...normalized }
    this.schedule()
    return this.get()
  }

  // THE WRITE, OFF THE MAIN THREAD (@item:orgtree/nick-pc-4-6-0-desktop-main-process-stalls-input-f item 6): every
  // preference change wrote temp + rename synchronously; the streamer sample and the tray reach set() from timers. Now
  // the live copy changes at once and the file follows: one async atomic write at a time, always of the latest value,
  // so a burst of changes coalesces. flushSync() at before-quit writes anything still pending, so a quit loses nothing.
  private dirty = false
  private writing: Promise<void> | null = null
  private schedule(): void {
    this.dirty = true
    this.writing ??= (async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          const text = JSON.stringify(this.value), epoch = this.epoch
          const temp = this.file + '.tmp-async'
          try {
            await fs.promises.mkdir(path.dirname(this.file), { recursive: true })
            await fs.promises.writeFile(temp, text, { mode: 0o600 })
            // flushSync has written the latest value: an older one must not land over it
            if (this.epoch !== epoch) { await fs.promises.rm(temp, { force: true }); continue }
            await fs.promises.rename(temp, this.file)
            // flushSync ran while this rename was in flight, so the older value may have landed over the newer one
            // (@rig-sol-b m7eafa4cbd300): put the latest back now. Only in the quit window; synchronous because the
            // process is about to end.
            if (this.epoch !== epoch) this.writeLatestSync()
            else this.failed = false
          } catch { /* the next change, or flushSync at quit, writes it again */ this.failed = true }
        }
      } finally { this.writing = null }
    })()
  }
  private failed = false
  private epoch = 0
  /** Settles when the file holds the latest value (tests). */
  async flush(): Promise<void> { while (this.writing) await this.writing }
  /** before-quit: write the latest value now if a write is pending, in flight or failed. */
  flushSync(): void {
    // pending, in flight (the process may end before it lands) or failed: write the latest value now; a write already
    // in flight that has not renamed yet stands down (its epoch is over); later changes are written as usual
    if (!this.dirty && !this.writing && !this.failed) return
    this.epoch++
    this.writeLatestSync()
  }
  /** the one synchronous write (quit only; tests/main-thread-guard.test.mjs lists its lines) */
  private writeLatestSync(): void {
    try {
      const next = this.value
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = this.file + '.tmp'
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
      fs.renameSync(temp, this.file)
      this.dirty = false; this.failed = false
    } catch { this.failed = true /* nothing more to do at quit */ }
  }
}
