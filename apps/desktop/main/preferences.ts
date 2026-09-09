import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PREFERENCES, preferencesPatch } from './policy'
import type { DesktopPreferences } from '../../../packages/contracts/index'

export class Preferences {
  private value: DesktopPreferences
  constructor(private file: string) {
    this.value = { ...DEFAULT_PREFERENCES }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      const patch = preferencesPatch(raw)
      // Alpha.5 stored the neutral theme as the default. Treat that legacy
      // value as unset unless the new provenance bit says the user chose it.
      // Any non-neutral stored theme is necessarily an earlier explicit pick.
      if (!Object.prototype.hasOwnProperty.call(patch, 'visualThemeExplicit')
          && Object.prototype.hasOwnProperty.call(patch, 'visualTheme')) {
        if (patch.visualTheme !== 'orgtree') patch.visualThemeExplicit = true
        else delete patch.visualThemeExplicit
      }
      this.value = { ...this.value, ...patch }
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
