import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Preferences } from '../../main/preferences'
import { ThemeSetting, startThemeSync, defaultThemeForProviders } from '../src/themes'

for (const provenance of [true, undefined, false]) {
  test(`legacy Grey migration preserves ${String(provenance)} provenance semantics`, async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'grey-migration-'))
    const file = path.join(folder, 'preferences.json')
    const legacy = { visualTheme: 'orgtree', ...(provenance === undefined ? {} : { visualThemeExplicit: provenance }) }
    writeFileSync(file, JSON.stringify(legacy))
    const expected = provenance === false ? 'claude' : 'custom:#b6bdc8'
    const explicit = provenance !== false
    const loaded = new Preferences(file)
    assert.equal(loaded.get().visualTheme, expected, 'read converts the retired id')
    assert.equal(loaded.get().visualThemeExplicit, explicit, 'unset is distinct from a chosen theme')
    assert.equal(loaded.set(legacy).visualTheme, expected, 'legacy writers normalize too')
    assert.equal(loaded.get().visualThemeExplicit, explicit)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).visualTheme, expected)
    assert.equal(new Preferences(file).get().visualTheme, expected, 'canonical reload is stable')
    const bytes = readFileSync(file, 'utf8')
    assert.throws(() => loaded.set({ visualTheme: 'not-a-theme' }), /Invalid visual theme/)
    assert.equal(readFileSync(file, 'utf8'), bytes, 'bad writes remain atomic')
    const fresh = new Preferences(path.join(folder, 'fresh.json')).get()
    assert.equal(fresh.visualTheme, 'claude'); assert.equal(fresh.visualThemeExplicit, false)
    assert.equal(defaultThemeForProviders({ providers: [{ id: 'openai', status: { installed: true } }] }), 'codex')
    assert.equal(defaultThemeForProviders({ providers: [] }), 'claude')

    // Browser storage has no provenance flag: a persisted value is a choice.
    if (provenance === undefined) {
      localStorage.clear(); localStorage.setItem('orgtree-visual-theme', 'orgtree')
      const stop = startThemeSync()
      const view = await mountView(<ThemeSetting />, el => el)
      try {
        await inAct(async () => { await flush() })
        assert.equal(localStorage.getItem('orgtree-visual-theme'), 'custom:#b6bdc8')
        assert.equal(document.documentElement.style.getPropertyValue('--accent'), '#b6bdc8')
        assert.equal(view.el.querySelector<HTMLSelectElement>('[aria-label="Visual theme"]')?.value, 'custom')
        assert.equal(view.el.querySelector<HTMLInputElement>('[aria-label="Custom theme color"]')?.value, '#b6bdc8')
        const labels = [...view.el.querySelector<HTMLSelectElement>('[aria-label="Visual theme"]')!.options].map(o => o.textContent)
        assert.equal(labels.includes('Orgtree Grey'), false)
        assert.equal(labels[0], 'Claude Terracotta'); assert.equal(labels.at(-1), 'Custom')
      } finally { await view.unmount(); stop(); localStorage.clear() }
    }
  })
}
