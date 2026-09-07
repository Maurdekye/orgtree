import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PREFERENCES, preferencesPatch } from './policy'
import type { DesktopPreferences } from '../../../packages/contracts/index'

export class Preferences {
  private value: DesktopPreferences
  constructor(private file: string) {
    this.value = { ...DEFAULT_PREFERENCES }
    try { this.value = { ...this.value, ...preferencesPatch(JSON.parse(fs.readFileSync(file, 'utf8'))) } } catch { /* Missing/corrupt settings use documented defaults. */ }
  }
  get(): DesktopPreferences { return { ...this.value } }
  set(patch: unknown): DesktopPreferences {
    const next = { ...this.value, ...preferencesPatch(patch) }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = this.file + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
    fs.renameSync(temp, this.file)
    this.value = next
    return this.get()
  }
}
