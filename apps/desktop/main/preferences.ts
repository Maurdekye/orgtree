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
    if (Object.prototype.hasOwnProperty.call(normalized, 'visualTheme')
        && !Object.prototype.hasOwnProperty.call(normalized, 'visualThemeExplicit')) {
      normalized.visualThemeExplicit = true
    }
    const next = { ...this.value, ...normalized }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = this.file + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    fs.renameSync(temp, this.file)
    this.value = next
    return this.get()
  }
}
