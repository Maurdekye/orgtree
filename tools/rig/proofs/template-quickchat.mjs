// Proof: organization templates carry Quick chat defaults (docket
// create-organizations-from-agent-layout-templates, user 2026-10-10 19:31Z;
// rulings 19:40Z: option B "template, until I pick", built-ins start on their
// coordinator with Opus / Sol, Save as template has the part ticked).
//   1. the seeded built-ins carry quick_chat (coordinator + opus / sol);
//   2. an org created from devteam (claude) stores them as its quick_chat
//      setting; a renamed coordinator is followed; a superior the layout no
//      longer holds (removed slot) is top level;
//   3. Save as template (API): the part is saved, a superior not in the org
//      is saved as top level, unticked it is left out;
//   4. the desktop: a fresh window in a template org starts on the
//      template's superior and model; a hand pick there shows at once and does
//      not change another template org; an org without defaults follows the
//      last pick anywhere; Save as template offers "Quick chat defaults"
//      ticked and the file carries what the box showed (screenshots).
// Run: node tools/rig/rig.mjs run tools/rig/proofs/template-quickchat.mjs [--ui <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'

const desk = (name) => fileURLToPath(new URL(`../desktop/${name}`, import.meta.url))

export default async function (rig) {
  const p = new Proof('template-quickchat')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const tpDir = path.join(rig.data, 'rig-home', '.orgtree', 'templates')
  const read = (f) => JSON.parse(fs.readFileSync(path.join(tpDir, f), 'utf8'))
  const qc = (slug) => rig.one(`SELECT settings->'quick_chat' AS q FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`)?.q ?? null
  // jsonb does not keep key order
  const same = (x, y) => !!x && !!y && Object.keys(x).length === Object.keys(y).length
    && Object.entries(y).every(([k, val]) => x[k] === val)
  const attempt = (f) => f.then((r) => ({ ok: true, r }), (e) => ({ ok: false, status: e.status, detail: e.body?.detail ?? e.message }))
  for (let i = 0; i < 120; i++) {
    const tiers = (await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)).tiers.map((t) => t.tier)
    if (tiers.includes('opus') && tiers.includes('sol')) break
    await new Promise((r) => setTimeout(r, 500))
  }
  await rig.waitFor(() => fs.existsSync(path.join(tpDir, 'devteam-codex.json')) || null, { what: 'the seeded built-ins', timeout: 30000 })

  // 1. the built-ins
  const bc = read('devteam-claude.json').quick_chat, bx = read('devteam-codex.json').quick_chat
  p.check('1 the seeded built-ins start Quick chat on their coordinator, with Opus / Sol',
    JSON.stringify(bc) === '{"superior":"coordinator","tier":"opus"}' && JSON.stringify(bx) === '{"superior":"coordinator","tier":"sol"}', { bc, bx })

  // 2. create
  const a = await attempt(rig.api('POST', '/api/orgs', { name: 'QC Alpha', dirs: [], template: { id: 'devteam-claude' } }))
  const b = await attempt(rig.api('POST', '/api/orgs', { name: 'QC Beta', dirs: [], template: { id: 'devteam-claude' } }))
  p.check('2 an org created from devteam (claude) stores its Quick chat defaults',
    a.ok && b.ok && same(qc('qc-alpha'), { superior: 'coordinator', tier: 'opus' }),
    { a: a.ok ? a.r.slug : a, b: b.ok ? b.r.slug : b, q: qc('qc-alpha') })
  const ren = await attempt(rig.api('POST', '/api/orgs', { name: 'QC Renamed', dirs: [],
    template: { id: 'devteam-claude', overrides: { coordinator: { name: 'chief' } } } }))
  p.check('2 a renamed coordinator is followed', ren.ok && qc('qc-renamed')?.superior === 'chief', { r: ren.ok ? ren.r.slug : ren, q: qc('qc-renamed') })
  const drop = read('devteam-claude.json')
  drop.id = 'qc-curator'; drop.name = 'QC curator'; drop.quick_chat = { superior: 'curator', effort: '' }
  fs.writeFileSync(path.join(tpDir, 'qc-curator.json'), JSON.stringify(drop, null, 2))
  const rem = await attempt(rig.api('POST', '/api/orgs', { name: 'QC Removed', dirs: [],
    template: { id: 'qc-curator', removed: ['curator'] } }))
  const qr = qc('qc-removed')
  p.check('2 a superior the layout no longer holds is top level; an explicit org-default effort is kept',
    rem.ok && qr && qr.superior === null && qr.effort === '' && !('tier' in qr), { r: rem.ok ? rem.r.slug : rem, q: qr })
  const none = await attempt(rig.api('POST', '/api/orgs', { name: 'QC Plain', dirs: [] }))
  p.check('2 an org created without a template has no Quick chat defaults', none.ok && qc('qc-plain') === null, qc('qc-plain'))

  // 3. save (API)
  const save = (name, body) => attempt(rig.api('POST', '/api/orgs/qc-alpha/template', { name, ...body }))
  const s1 = await save('QC saved', { quick_chat: { superior: 'redteam', tier: 'sonnet', effort: 'high' } })
  const s2 = await save('QC gone', { quick_chat: { superior: 'not-here', tier: 'opus' } })
  const s3 = await save('QC unticked', { quick_chat: { superior: 'redteam' }, include: { quick_chat: false } })
  p.check('3 Save as template writes the Quick chat part',
    s1.ok && JSON.stringify(read('qc-saved.json').quick_chat) === JSON.stringify({ superior: 'redteam', tier: 'sonnet', effort: 'high' }), read('qc-saved.json').quick_chat)
  p.check('3 a superior the org does not hold is saved as top level',
    s2.ok && JSON.stringify(read('qc-gone.json').quick_chat) === JSON.stringify({ superior: null, tier: 'opus' }), read('qc-gone.json').quick_chat)
  p.check('3 unticked, the part is left out', s3.ok && !('quick_chat' in read('qc-unticked.json')), Object.keys(read('qc-unticked.json')))
  const bad = await attempt(rig.api('POST', `/api/orgs/${rig.org}/settings`, { quick_chat: { tier: 'nope' } }))
  p.check('3 a bad quick_chat setting is refused', !bad.ok && bad.status === 422, bad)

  // 4. desktop
  const d = await runDesktop(rig, desk('template-quickchat.cjs'), { preset: '1600x900', out: path.join(p.dir, 'desktop'), timeout: 240000,
    args: { a: 'qc-alpha', b: 'qc-beta', seed: rig.org, name: 'QC from desktop' } })
  const v = d.value ?? {}
  p.check('4 the desktop script ran', d.ok, d.ok ? undefined : d)
  p.check('4 a fresh window in a template org starts on the template superior and model',
    v.aFresh?.superior === 'coordinator' && v.aFresh?.model === 'opus', v.aFresh)
  p.check('4 a model picked by hand there shows at once', v.aPicked?.model === 'haiku' && v.aPicked?.superior === 'coordinator', v.aPicked)
  p.check('4 another org from the template still starts on the template model',
    v.bFresh?.model === 'opus' && v.bFresh?.superior === 'coordinator', v.bFresh)
  p.check('4 an org without defaults follows the last pick anywhere (model), superior top level',
    v.seed?.model === 'haiku' && v.seed?.superior === 'top level', v.seed)
  p.check('4 back in the first org its own pick is kept', v.aAgain?.model === 'haiku', v.aAgain)
  const g = (v.groups ?? []).find((x) => x.text.startsWith('Quick chat defaults'))
  p.check('4 Save as template offers "Quick chat defaults", ticked', !!g && g.checked, v.groups)
  const saved = fs.existsSync(path.join(tpDir, 'qc-from-desktop.json')) ? read('qc-from-desktop.json') : null
  p.check('4 the saved file carries what the box showed (coordinator, haiku)',
    saved && saved.quick_chat?.superior === 'coordinator' && saved.quick_chat?.tier === 'haiku', saved?.quick_chat ?? saved)
  return p.summary()
}
