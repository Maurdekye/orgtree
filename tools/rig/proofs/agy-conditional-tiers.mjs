// Proof: the conditional Gemini tiers (Argon, Barium, Carbon) follow the
// account's `agy models` registry while the engine runs, with no restart
// (docket gemini-4-argon-is-selectable-in-agy-but-orgtree-d).
//   - the fake agy prints the registry from fakecli/agy-models.txt; discovery
//     runs every 2 s in this run (ORGTREE_RIG_DISCOVERY_S) instead of 300 s
//   - without Argon in the registry: no Argon row in the providers payload,
//     staffing does not offer it; flash is offered (control)
//   - Argon listed with effort suffixes: Argon appears in both, Barium and
//     Carbon stay hidden (each tier judged on its own id)
//   - exact id: `gemini-4-argonite` / `gemini-4-argon-preview` are no evidence
//   - signed out (no rows): Argon disappears, Antigravity stays installed
//   - the bare id counts; the engine ran `agy --log-file <f> models` and kept
//     its log as diagnostics/agy-probe/models-probe.log, no per-probe leftovers
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-conditional-tiers.mjs

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

export async function setup() {
  return { discoveryS: 2 }
}

const MEASURED = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)', 'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
]
const CONDITIONAL = ['argon', 'barium', 'carbon']

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
  // one discovery after `n` calls has published: the next completed read
  const nextRead = async (what) => {
    const n = calls().length
    await rig.waitFor(() => calls().length >= n + 2, { what: `two more agy models reads (${what})`, timeout: 30000 })
  }

  registry(MEASURED)
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers')).checking === false, { what: 'first discovery', timeout: 60000 })
  await nextRead('baseline')
  const g = await google()
  p.check('control: Antigravity is installed in this rig (its fake CLI) and offers flash', g?.status?.installed !== false && (await offered()).includes('flash'), g?.status)
  p.check('without Argon in the registry no conditional tier is offered', !(await offered()).some((t) => CONDITIONAL.includes(t)), await offered())
  p.check('staffing offers no conditional tier either', !(await staffed()).some((t) => CONDITIONAL.includes(t)), await staffed())

  registry(['gemini-4-argon-high\tGemini 4 Argon (High)', 'gemini-4-argon-low\tGemini 4 Argon (Low)', ...MEASURED])
  await rig.waitFor(async () => (await offered()).includes('argon'), { what: 'Argon to be offered', timeout: 30000 })
  p.check('Argon is offered once agy lists it, with no restart', (await offered()).includes('argon'))
  p.check('Barium and Carbon stay hidden: each tier is judged on its own id',
    !(await offered()).includes('barium') && !(await offered()).includes('carbon'), await offered())
  p.check('staffing offers Argon too', (await staffed()).includes('argon'), await staffed())
  const row = ((await google())?.tiers ?? []).find((t) => t.tier === 'argon')
  p.check('the Argon row is the catalog row (gemini-4-argon, letter A, seat 2)', row?.model === 'gemini-4-argon' && row?.letter === 'A' && row?.seat === 2, row)

  registry(['gemini-4-argonite\tGemini 4 Argonite', 'gemini-4-argon-preview\tGemini 4 Argon Preview', 'Gemini 4 Argon (Medium)\tGemini 4 Argon (Medium)', ...MEASURED])
  await rig.waitFor(async () => !(await offered()).includes('argon'), { what: 'Argon to be withdrawn', timeout: 30000 })
  p.check('exact id: another model sharing the prefix, or a label, is no evidence', !(await offered()).includes('argon'), await offered())

  registry(['gemini-4-argon\tGemini 4 Argon', ...MEASURED])
  await rig.waitFor(async () => (await offered()).includes('argon'), { what: 'Argon (bare id) to be offered', timeout: 30000 })
  p.check('the bare id counts', (await offered()).includes('argon'))

  registry([])
  await rig.waitFor(async () => !(await offered()).includes('argon'), { what: 'Argon to be withdrawn when signed out', timeout: 30000 })
  p.check('signed out (no rows): Argon disappears, with no restart', !(await offered()).includes('argon') && !(await staffed()).includes('argon'))
  p.check('control: Antigravity is still listed and still offers flash', (await offered()).includes('flash'))

  const last = calls().at(-1)
  p.check('the engine ran `agy --log-file <file> models`', last?.args?.includes('models') && last?.args?.includes('--log-file'), last)
  const probeDir = path.join(rig.data, 'diagnostics', 'agy-probe')
  const files = fs.existsSync(probeDir) ? fs.readdirSync(probeDir) : []
  p.check('its log is kept as models-probe.log, with no per-probe leftovers',
    files.includes('models-probe.log') && !files.some((f) => /^models-probe\..+\.log$/.test(f)), files)
  p.check('the engine logs what the registry offered', /Antigravity model list/.test(rig.engineLog()))
  return p.summary()
}
