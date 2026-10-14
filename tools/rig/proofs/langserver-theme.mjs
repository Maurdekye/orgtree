// LS Gold: real settings picker and Language Server agent card,
// using the rig's fake model catalog (no local model or account required).
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { seed } from '../fixture.mjs'
import { startFakeLlm } from '../fakellm.mjs'
import { runDesktop } from '../desktop.mjs'
import { THEME_ACCENTS } from '../../../packages/contracts/visual-theme.ts'

export const setup = () => ({ name: 'langserver-theme', fixture: 'none' })

export default async function (rig) {
  const p = new Proof('langserver-theme')
  const llm = await startFakeLlm({ models: [{ name: 'fake-model:latest', context: 65536 }] })
  try {
    const server = await rig.api('POST', '/api/langservers', {
      preset: 'ollama', address: llm.url, harness: 'claude-code', label: 'Gold smoke server',
      models: [{ id: 'fake-model:latest', context: 65536 }],
    })
    const tier = Object.values(server.server?.models ?? {})[0]?.tier
    if (!tier) throw new Error('fake model catalog did not produce a Language Server tier')
    await seed(rig, { org: { name: 'Gold Smoke' }, agents: [
      { name: 'gold-agent', tier, grant: 1, charter: 'Disposable Language Server theme smoke.' },
    ] })
    const status = await rig.tool('gold-agent', 'orgtree_status', { status: 'done', summary: 'LS Gold smoke' })
    p.check('Language Server agent reports through the real tool route', status.ok, status.text)
    const r = await runDesktop(rig, path.join(import.meta.dirname, '../desktop/langserver-theme.cjs'), {
      preset: 'wide', out: path.join(p.dir, 'desktop'), timeout: 120000,
    })
    const warnings = (r.value?.errors ?? []).filter(e => e.includes('Electron Security Warning (Insecure Content-Security-Policy)'))
    const errors = (r.value?.errors ?? []).filter(e => !warnings.includes(e))
    if (warnings.length) p.note('Electron development CSP warning from the offscreen rig', warnings)
    p.check('offscreen renderer completed without application errors', r.ok !== false && !errors.length, r.error ?? errors)
    const v = r.value ?? {}
    p.check('the settings picker offers and saves LS Gold', v.label === 'LS Gold'
      && v.stored === 'langserver' && v.accent === THEME_ACCENTS.langserver, v)
    p.check('a Language Server card retains the designated gold tier border',
      v.card?.provider === 'rgb(205, 162, 6)' && v.card?.tier === THEME_ACCENTS.langserver
      && v.card?.border === v.card?.tierBorder, v.card)
    p.check('provider text retains the existing deep gold on light surfaces', v.light?.provider === '#4d3a02', v.light)
    return p.summary()
  } finally { await llm.close() }
}
