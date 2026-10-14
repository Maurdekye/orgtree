// Proof: the conditional Gemini tiers (Argon, Barium, Carbon) follow the
// account's `agy models` registry, read when it matters and never polled
// (docket gemini-4-argon-is-selectable-in-agy-but-orgtree-d; user 2026-10-14).
//   - the fake agy prints the registry from fakecli/agy-models.txt (absent:
//     the measured list without the Gemini 4 models); every run is logged
//   - the engine reads it once at start; with no model choice opened, no
//     further read happens (no periodic reads)
//   - opening a model choice (the renderer's POST
//     /api/providers/agy-models/refresh) re-reads it: Argon appears with no
//     restart, Barium and Carbon stay hidden (each judged on its own id)
//   - debounce: a refresh under 30 s after a read reuses it (no new run)
//   - exact id: `gemini-4-argonite`, `gemini-4-argon-preview` and a label are
//     no evidence; signed out (no rows) withdraws Argon
//   - admission (3.x provider_hire_gate, coordinator ruling 2026-10-14): a
//     hire, a model switch or a rehire NAMING Argon while agy does not list
//     it is refused with the reason; a plain rehire on the stored tier (the
//     recovery door) is not, and a seat already on Argon is never touched
//   - the engine ran `agy --log-file <f> models` and kept its log as
//     diagnostics/agy-probe/models-probe.log, with no per-probe leftovers
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-conditional-tiers.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const MEASURED = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)', 'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
]
const CONDITIONAL = ['argon', 'barium', 'carbon']
const REUSE_MS = 30_000
const NOT_LISTED = /not in the model list the Antigravity CLI returns/
const refusal = (pr) => pr.then(() => null, (e) => ({ status: e.status ?? -1, message: String(e.message ?? e) }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default async function (rig) {
  const p = new Proof('agy-conditional-tiers')
  const registry = (rows) => fs.writeFileSync(path.join(rig.fakeDir, 'agy-models.txt'), rows.map((r) => r + '\r\n').join(''))
  const google = async () => ((await rig.api('GET', '/api/providers')).providers ?? []).find((x) => x.id === 'google')
  const offered = async () => ((await google())?.tiers ?? []).map((t) => t.tier)
  const staffed = async () => ((await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)).tiers ?? []).map((t) => t.tier ?? t)
  const calls = () => {
    const f = path.join(rig.fakeDir, 'log', 'agy-models.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }
  // a model choice opens: the renderer's refresh call
  const open = () => rig.api('POST', '/api/providers/agy-models/refresh')
  // wait out the reuse window after the last read, then open a choice
  const openFresh = async () => {
    const last = Date.parse(calls().at(-1)?.at ?? 0)
    await sleep(Math.max(0, last + REUSE_MS + 1500 - Date.now()))
    const n = calls().length
    await open()
    return calls().length - n
  }
  const seat = (name) => rig.sql(`SELECT state, tier FROM ot.agents WHERE name = '${name}'`)[0]

  // 1. engine start: one read, then none until a choice opens
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers')).checking === false, { what: 'first discovery', timeout: 60000 })
  await rig.waitFor(() => calls().length >= 1, { what: 'the start-up agy models read', timeout: 60000 })
  const atStart = calls().length
  await sleep(8000)
  p.check('the engine read the list once at start and not again with no model choice opened', atStart === 1 && calls().length === 1, calls().length)
  const g = await google()
  p.check('control: Antigravity is installed in this rig (its fake CLI) and offers flash', g?.status?.installed !== false && (await offered()).includes('flash'), g?.status)
  p.check('without Argon in the registry no conditional tier is offered', !(await offered()).some((t) => CONDITIONAL.includes(t)), await offered())
  p.check('staffing offers no conditional tier either', !(await staffed()).some((t) => CONDITIONAL.includes(t)), await staffed())

  // 2. admission while not listed
  let r = await refusal(rig.op({ op: 'hire', name: 'arg0', parent: 'boss', tier: 'argon', title: 'Argon seat' }))
  p.check('a hire naming Argon while agy does not list it is refused, saying why', r?.status === 409 && NOT_LISTED.test(r.message), r)
  p.check('control: the refused hire created no agent', rig.sql("SELECT 1 FROM ot.agents WHERE name = 'arg0'").length === 0)
  await rig.op({ op: 'hire', name: 'fla', parent: 'boss', tier: 'flash', title: 'Flash seat' })
  r = await refusal(rig.op({ op: 'switch_model', node: 'fla', tier: 'argon' }))
  p.check('a model switch to Argon is refused the same way', r?.status === 409 && NOT_LISTED.test(r.message), r)

  // 3. agy starts listing Argon: debounce, then a model choice opening shows it
  registry(['gemini-4-argon-high\tGemini 4 Argon (High)', 'gemini-4-argon-low\tGemini 4 Argon (Low)', ...MEASURED])
  const before = calls().length
  const last = Date.parse(calls().at(-1)?.at ?? 0)
  await open()
  if (Date.now() - last < REUSE_MS - 2000) {
    p.check('debounce: a choice opened under 30 s after a read reuses it (no new agy run)', calls().length === before, calls().length - before)
  }
  p.check('opening a model choice after the reuse window runs one fresh read', (await openFresh()) === 1)
  p.check('Argon is offered once agy lists it, with no restart', (await offered()).includes('argon'), await offered())
  p.check('Barium and Carbon stay hidden: each tier is judged on its own id',
    !(await offered()).includes('barium') && !(await offered()).includes('carbon'), await offered())
  p.check('staffing offers Argon too', (await staffed()).includes('argon'), await staffed())
  const row = ((await google())?.tiers ?? []).find((t) => t.tier === 'argon')
  p.check('the Argon row is the catalog row (gemini-4-argon, letter A, seat 2)', row?.model === 'gemini-4-argon' && row?.letter === 'A' && row?.seat === 2, row)
  r = await refusal(rig.op({ op: 'hire', name: 'arg1', parent: 'boss', tier: 'argon', title: 'Argon seat' }))
  p.check('a hire naming Argon is accepted while agy lists it', r === null, r)
  await rig.op({ op: 'hire', name: 'arg2', parent: 'boss', tier: 'argon', title: 'Argon seat to retire' })
  await rig.op({ op: 'retire', node: 'arg2' })
  await rig.op({ op: 'hire', name: 'fl2', parent: 'boss', tier: 'flash', title: 'Flash seat to retire' })
  await rig.op({ op: 'retire', node: 'fl2' })

  // 4. exact id: lookalikes are no evidence
  registry(['gemini-4-argonite\tGemini 4 Argonite', 'gemini-4-argon-preview\tGemini 4 Argon Preview', 'Gemini 4 Argon (Medium)\tGemini 4 Argon (Medium)', ...MEASURED])
  await openFresh()
  p.check('exact id: another model sharing the prefix, or a label, is no evidence', !(await offered()).includes('argon'), await offered())

  // 5. signed out: no rows
  registry([])
  await openFresh()
  p.check('signed out (no rows): Argon disappears, with no restart', !(await offered()).includes('argon') && !(await staffed()).includes('argon'))
  p.check('control: Antigravity is still listed and still offers flash', (await offered()).includes('flash'))
  p.check('the seat already on Argon is untouched: still live, still Argon', seat('arg1')?.state === 'live' && seat('arg1')?.tier === 'argon', seat('arg1'))
  r = await refusal(rig.op({ op: 'hire', name: 'arg3', parent: 'boss', tier: 'argon', title: 'Argon seat' }))
  p.check('signed out: a hire naming Argon is refused again', r?.status === 409 && NOT_LISTED.test(r.message), r)
  r = await refusal(rig.op({ op: 'rehire', node: 'fl2', tier: 'argon' }))
  p.check('a rehire naming Argon is refused', r?.status === 409 && NOT_LISTED.test(r.message), r)
  r = await refusal(rig.op({ op: 'rehire', node: 'arg2' }))
  p.check('a plain rehire on the stored Argon tier is the recovery door: not refused by this gate', !(r && NOT_LISTED.test(r.message)), r)

  // 6. how it was read
  const lastCall = calls().at(-1)
  p.check('the engine ran `agy --log-file <file> models`', lastCall?.args?.includes('models') && lastCall?.args?.includes('--log-file'), lastCall)
  const probeDir = path.join(rig.data, 'diagnostics', 'agy-probe')
  const files = fs.existsSync(probeDir) ? fs.readdirSync(probeDir) : []
  p.check('its log is kept as models-probe.log, with no per-probe leftovers',
    files.includes('models-probe.log') && !files.some((f) => /^models-probe\..+\.log$/.test(f)), files)
  p.check('the engine logs what the registry offered', /Antigravity model list/.test(rig.engineLog()))
  return p.summary()
}
