// Proof: Quick chat in the v3 organization-window header (user 2026-10-10).
//   - centred in the header at three widths, in the dark (charcoal) and light
//     contrast themes, never overlapping the controls on either side;
//   - the same header entry in the Attention view, still centred;
//   - the superior menu lists "top level" then the live agents in exactly the
//     order the Agents List on screen shows them, on Canvas and in Attention.
//   A few agents are hired so position order differs from tree order and from
//   alphabetical order.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/quick-chat-header.mjs --ui <bundle>

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const WIDTHS = ['1920x1080', '1280x800', '760x700']

export default async function (rig) {
  const p = new Proof('quick-chat-header')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'seed turns to settle', timeout: 60000 })
  // top-level and nested agents whose names sort differently from where they sit
  await rig.op({ op: 'hire', name: 'zulu', parent: null, tier: 'haiku', grant: 0 })
  await rig.op({ op: 'hire', name: 'able', parent: 'boss', tier: 'haiku', grant: 0 })
  await rig.op({ op: 'hire', name: 'mike', parent: 'carol', tier: 'haiku', grant: 0 })
  for (const theme of ['charcoal', 'light']) {
    const r = await runDesktop(rig, path.join(here, '../desktop/quick-chat-header.cjs'),
      { preset: WIDTHS[0], out: path.join(p.dir, theme), timeout: 240000,
        args: { org: rig.org, theme, widths: WIDTHS } })
    p.check(`${theme}: the desktop script ran`, r.ok, r.ok ? undefined : r)
    const v = r.value ?? {}
    for (const w of WIDTHS) {
      const m = v.widths?.[w]
      p.check(`${theme} ${w}: Quick chat centred in the header (within 1px)`, m && Math.abs(m.centreOffset) <= 1, m)
      p.check(`${theme} ${w}: no overlap with the controls either side`, m && m.gapLeft >= 0 && m.gapRight >= 0, m)
    }
    p.check(`${theme}: the Attention view shows the same entry, centred`,
      v.attention && Math.abs(v.attention.centreOffset) <= 1 && v.attention.gapLeft >= 0 && v.attention.gapRight >= 0, v.attention)
    const same = (menu, list) => JSON.stringify(menu) === JSON.stringify(['top level', ...(list ?? [])])
    p.check(`${theme}: Canvas — the superior menu is "top level" then the Agents List order`,
      same(v.canvasMenu, v.canvasList), { menu: v.canvasMenu, list: v.canvasList })
    p.check(`${theme}: Attention — the superior menu is "top level" then the agents drawer order`,
      same(v.attentionMenu, v.attentionList), { menu: v.attentionMenu, list: v.attentionList })
    const sorted = [...(v.canvasList ?? [])].sort()
    p.note(`${theme}: list order vs alphabetical`, { list: v.canvasList, alphabetical: sorted })
    const errors = (v.errors ?? []).filter(e => !/Electron Security Warning/.test(String(e)))
    p.check(`${theme}: no console errors`, !errors.length, errors)
  }
  return p.summary()
}
