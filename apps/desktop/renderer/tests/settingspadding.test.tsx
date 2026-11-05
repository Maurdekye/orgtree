// settingspadding.test.tsx — every agent-settings tab (and the project settings tabs) sits at ONE content inset:
// the app-settings-panel's own (none beyond the window's --panel-pad), which is what the four config tabs and every
// App settings tab already use. History and States used to add their own (.msgs 3px 2px; .agent-states 8px 12px), so
// their content edge sat inside/outside the others' when switching tabs
// (@item:orgtree/agent-settings-tabs-have-inconsistent-padding, USER 2026-11-05 10:22:19Z m2ea34a20eb90).
// Run:  cd apps/desktop/renderer && node tests/run.mjs settingspadding
import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const read = (f: string) => readFileSync(joinPath(__SRC_DIR__, f), 'utf8')
const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '')
/** the declarations of EVERY rule whose selector list contains `sel` exactly */
function lastBlock(sel: string): string {
  let out = ''
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").map(s => s.trim()).includes(sel)) out += m[2]
  }
  return out
}

test('no agent-settings tab body adds its own padding on top of the panel inset', () => {
  assert.match(lastBlock('.settings.cfg .agent-history-tab .msgs'), /padding:\s*0\s*[;}]?/, 'History body: no inset of its own')
  assert.match(lastBlock('.settings.cfg .agent-history-tab .agent-states'), /padding:\s*0\s*[;}]?/, 'States body: no inset of its own')
})

test('every agent and project settings tab panel is the shared panel class, so a new tab starts at the same inset', () => {
  const src = read('canvas/modals.tsx')
  for (const m of src.matchAll(/<SettingsTabPanel\b[^>]*?className="([^"]*)"/g)) {
    assert.match(m[1], /^app-settings-panel\b/, 'a custom panel class must extend app-settings-panel: ' + m[1])
  }
  assert.equal(lastBlock('.app-settings-panel').includes('padding'), false, 'the shared panel itself adds none (the window owns --panel-pad)')
})
