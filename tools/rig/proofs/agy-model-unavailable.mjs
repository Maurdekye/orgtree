// Proof: a turn on an Antigravity model the account cannot run ends soon, with a plain reason
// (USER 2026-11-13 m6258781910ea: Gemini Hydrogen is offered on every Antigravity account whatever
// `agy models` lists, so its turns "will fail until the account really has access", and must fail
// with a clear "not available on this account", never hang).
//   - the fake agy's registry lists Carbon and no Hydrogen; Hydrogen is offered and hired anyway,
//     and Flash, a legacy model now, is not offered
//   - the CLI refuses the model in its own words: the turn ends at once, and its error says the
//     model is not available on this Antigravity account, with the CLI's words kept in brackets
//   - the CLI fails without naming a model: the account's own list is the evidence, same reason
//   - control: the same vague failure on Carbon, which the account lists, keeps its own words
//   - the CLI never answers: the turn is stopped after the unlisted-model silence bound (120 s),
//     far short of the ordinary silence limit, with the same reason
// Run: node tools/rig/rig.mjs run tools/rig/proofs/agy-model-unavailable.mjs   (about 3.5 minutes)

import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const REGISTRY = [
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)', 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)', 'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
]
const REFUSED = 'Model gemini-4-hydrogen not found for this account.'
const VAGUE = 'INTERNAL: the request failed.'
const PLAIN = 'Gemini Hydrogen 4 (gemini-4-hydrogen) is not available on this Antigravity account'
const LISTED = `${PLAIN}: the account's model list does not include it.`
const REUSE_MS = 30_000
const BOUND_MS = 120_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const refusal = (pr) => pr.then(() => null, (e) => ({ status: e.status ?? -1, message: String(e.message ?? e) }))

export default async function (rig) {
  const p = new Proof('agy-model-unavailable')
  rig.scenario({
    agents: {
      hyd: { turns: [
        { name: 'refused', match: 'PROOF-REFUSED', once: true, steps: [{ error: REFUSED }] },
        { name: 'vague', match: 'PROOF-VAGUE', once: true, steps: [{ error: VAGUE }] },
      ] },
      car: { turns: [{ name: 'vague', match: 'PROOF-VAGUE', once: true, steps: [{ error: VAGUE }] }] },
      hush: { turns: [{ name: 'silent', match: 'PROOF-SILENT', once: true, steps: [{ sleep_ms: 400000 }, { text: 'NEVER-SAID' }] }] },
    },
  })
  const google = async () => ((await rig.api('GET', '/api/providers')).providers ?? []).find((x) => x.id === 'google')
  const offered = async () => ((await google())?.tiers ?? []).map((t) => t.tier)
  const staffed = async () => ((await rig.api('GET', `/api/orgs/${rig.org}/staffing-options`)).tiers ?? []).map((t) => t.tier ?? t)
  const calls = () => {
    const f = path.join(rig.fakeDir, 'log', 'agy-models.jsonl')
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  }

  // 1. the account lists Carbon and no Hydrogen; the engine has read that list
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers')).checking === false, { what: 'first discovery', timeout: 60000 })
  await rig.waitFor(() => calls().length >= 1, { what: 'the start-up agy models read', timeout: 60000 })
  fs.writeFileSync(path.join(rig.fakeDir, 'agy-models.txt'), REGISTRY.map((r) => r + '\r\n').join(''))
  await sleep(Math.max(0, Date.parse(calls().at(-1)?.at ?? 0) + REUSE_MS + 1500 - Date.now()))
  await rig.api('POST', '/api/providers/agy-models/refresh')
  await rig.waitFor(async () => (await offered()).includes('carbon'), { what: 'the engine to read the registry that lists Carbon', timeout: 30000 })
  p.check('control: the account lists Carbon, so Carbon is offered', (await offered()).includes('carbon'), await offered())
  p.check('Hydrogen is offered although the account does not list it', (await offered()).includes('hydrogen') && (await staffed()).includes('hydrogen'),
    { offered: await offered(), staffed: await staffed() })
  p.check('Flash is a legacy model: neither the providers rows nor staffing offer it', !(await offered()).includes('flash') && !(await staffed()).includes('flash'),
    { offered: await offered(), staffed: await staffed() })
  const row = ((await google())?.tiers ?? []).find((t) => t.tier === 'hydrogen')
  p.check('the Hydrogen row is the catalog row (gemini-4-hydrogen, letter H, seat 1)', row?.model === 'gemini-4-hydrogen' && row?.letter === 'H' && row?.seat === 1, row)

  // 2. hired anyway
  let r = await refusal(rig.op({ op: 'hire', name: 'hyd', parent: 'boss', tier: 'hydrogen', title: 'Hydrogen seat' }))
  p.check('a hire naming Hydrogen is accepted while agy does not list it', r === null, r)
  r = await refusal(rig.op({ op: 'hire', name: 'hush', parent: 'boss', tier: 'hydrogen', title: 'Hydrogen seat that gets no answer' }))
  p.check('…and a second one', r === null, r)
  r = await refusal(rig.op({ op: 'hire', name: 'car', parent: 'boss', tier: 'carbon', title: 'Carbon seat' }))
  p.check('control: a Carbon seat is hired too', r === null, r)

  // 3. the CLI refuses the model in its own words
  let t0 = Date.now()
  await rig.userMail('hyd', 'PROOF-REFUSED: say hello.')
  let turns = await rig.waitTurns('hyd', 1, { timeout: 150000 })
  let took = Date.parse(turns[0].ended_at) - t0
  p.check('a refused Hydrogen turn says the model is not available on this account, keeping the CLI\'s words',
    turns[0].error === `${LISTED} (${REFUSED})`, turns[0].error)
  p.check('…and ends at once, not at a time limit (helper start aside: under 90 s)', took < 90000, took)

  // 4. a failure that names no model: the account's own list is the evidence
  await rig.userMail('hyd', 'PROOF-VAGUE: say hello again.')
  turns = await rig.waitTurns('hyd', 2, { timeout: 150000 })
  p.check('a vague failure on a model the account does not list gets the same plain reason', turns[1].error === `${LISTED} (${VAGUE})`, turns[1].error)

  // 5. control: the same vague failure on a model the account lists keeps its own words
  await rig.userMail('car', 'PROOF-VAGUE: say hello.')
  const cturns = await rig.waitTurns('car', 1, { timeout: 150000 })
  p.check('control: the same failure on Carbon, which the account lists, is left as the CLI said it', cturns[0].error === VAGUE, cturns[0].error)

  // 6. the CLI never answers: stopped at the unlisted-model bound, not the ordinary silence limit
  await rig.userMail('hush', 'PROOF-SILENT: say hello.')
  await rig.waitFor(() => rig.fakeLog('hush').some((l) => l.kind === 'step' && l.step?.sleep_ms), { what: 'hush to be mid-turn, silent', timeout: 150000 })
  t0 = Date.now()
  const hturns = await rig.waitTurns('hush', 1, { timeout: BOUND_MS + 60000 })
  took = Date.parse(hturns[0].ended_at) - t0
  p.check('a Hydrogen turn that gets no answer is stopped after about 120 s of silence', took > BOUND_MS - 15000 && took < BOUND_MS + 30000, took)
  p.check('…with the same plain reason, and what happened in brackets',
    hturns[0].error === `${LISTED} (the turn produced nothing for too long and was stopped)`, hturns[0].error)
  p.check('nothing was said after the stop', !rig.fakeLog('hush').some((l) => /NEVER-SAID/.test(JSON.stringify(l.step ?? ''))))
  return p.summary()
}
