// Proof: an agent on the OpenRouter lane, through the real engine, with the
// gateway scripted (rig mode's canned key check, rig-home\rig-usage\
// openrouter-key.json):
//   orbit:  openrouter.ai starts refusing the stored key and orbit's turn
//           comes back 401 → parked with the OpenRouter remedy in `until`
//           (the 3.x shape) → the lane's document is re-checked at once, so
//           the providers panel stops saying "connected" (3.x
//           forget_key_status; 4.0 used to push it every 5 minutes only);
//   orbit2: its fourth balance refusal in a row (402) → parked with the
//           balance remedy in `until`.
//   a key check without the credit fields (/credits refused the key):
//           the panel's document still answers (it used to panic).
// The key and the favorite come from a 3.x openrouter\state.json, carried
// over at the first start as an upgrade would.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/openrouter-lane.mjs

import fs from 'node:fs'
import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { RIG_DIR } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const TIER = 'or-rig-fake-model'
// what openrouter.ai answers for an accepted key when /credits answers too
const FULL = { label: 'rig key', limit: null, limit_remaining: null, limit_reset: null, usage: 1.5, usage_daily: 0.5, usage_weekly: 1,
               usage_monthly: 1.5, is_free_tier: false, total_credits: 10, total_usage: 1.5 }
const keyCheck = (data, doc) => {
  const dir = path.join(data, 'rig-home', 'rig-usage')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'openrouter-key.json'), JSON.stringify(doc))
}

export async function setup() {
  return {
    name: 'openrouter',
    prepare: async ({ data }) => {
      fs.mkdirSync(path.join(data, 'openrouter'), { recursive: true })
      fs.writeFileSync(path.join(data, 'openrouter', 'state.json'), JSON.stringify({
        key: 'sk-or-rig-not-a-real-key',
        favorites: [{ id: 'rig/fake-model', tier: TIER, name: 'Rig fake model', vendor: 'rig', prompt: 1, completion: 2, context: 100000, tools: true }],
      }))
      keyCheck(data, { status: 200, data: FULL })
    },
  }
}

const feedDoc = async rig => (await rig.api('GET', '/api/app/records'))?.runtime?.values?.openrouter ?? null
const look = (rig, p, agent, tag) => runDesktop(rig, path.join(RIG_DIR, 'desktop', 'frozen-card.cjs'),
  { preset: 'tall', args: { agent }, out: path.join(p.dir, `${agent}-${tag}`) })

export default async function (rig) {
  const p = new Proof('openrouter-lane')
  rig.scenario({
    agents: {
      orbit: { turns: [{ name: 'refused', match: 'PROOF-OR-401', once: true, steps: [
        { text: 'Trying.' },
        { result: { is_error: true, api_error_status: 401, text: 'API Error: 401 {"error":{"message":"User not found.","code":401}}' } },
      ] }] },
      orbit2: { turns: [{ name: 'balance', match: 'PROOF-OR-402', once: true, steps: [
        { text: 'Trying.' },
        { result: { is_error: true, api_error_status: 402, text: 'API Error: 402 {"error":{"message":"Insufficient credits.","code":402}}' } },
      ] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })

  // the 3.x key and favorite were carried over; openrouter.ai (scripted) accepts the key
  const doc = await rig.api('GET', '/api/openrouter')
  p.check('the 3.x key and favorite were carried over and the key is accepted', doc.key_set === true && doc.connected === true
    && (doc.tiers ?? []).some(t => t.tier === TIER), { key_set: doc.key_set, connected: doc.connected, tiers: (doc.tiers ?? []).map(t => t.tier) })
  const pushed0 = await rig.waitFor(async () => (await feedDoc(rig))?.value?.connected === true ? await feedDoc(rig) : null,
    { what: 'the pushed OpenRouter document to say connected', timeout: 20000 }).catch(() => null)
  p.check('the pushed document (what the panel shows) says connected', pushed0?.value?.connected === true, pushed0 && { seq: pushed0.seq, connected: pushed0.value.connected })

  // two agents on the OpenRouter tier
  for (const name of ['orbit', 'orbit2']) await rig.op({ op: 'hire', name, parent: 'boss', tier: TIER, grant: 1, title: 'OpenRouter lane' })
  p.check('agents hired on the OpenRouter tier', ['orbit', 'orbit2'].every(n => rig.one(`SELECT tier FROM ot.agents WHERE name = '${n}'`)?.tier === TIER))
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'hire turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- orbit: 401
  keyCheck(rig.data, { status: 401 })          // openrouter.ai now refuses the stored key
  const before = await feedDoc(rig)
  p.check('until a turn is refused, the pushed document still says connected', before?.value?.connected === true, { seq: before?.seq })
  const t0 = Date.now()
  await rig.userMail('orbit', 'PROOF-OR-401: please try.')
  const parked = await rig.waitFor(() => rig.agentRow('orbit')?.frozen ?? null, { what: 'orbit to be parked', timeout: 60000 })
  p.check('orbit: 401 on the OpenRouter lane → parked (cause auth)', parked.cause === 'auth' && parked.parked === true, parked)
  p.check('orbit: `until` names the OpenRouter door (3.x shape)',
    parked.until === 'credential rejected — replace the OpenRouter key in App settings → Providers, then resume', parked.until)
  const after = await rig.waitFor(async () => {
    const d = await feedDoc(rig)
    return d && d.value?.connected === false ? d : null
  }, { what: 'the pushed document to stop saying connected', timeout: 30000, every: 250 }).catch(() => null)
  p.check('the panel stops saying "connected" right after the refusal (re-checked, not 5 minutes later)', !!after
    && after.seq > (before?.seq ?? 0) && /rejected/.test(String(after.value?.reason ?? '')),
    after ? { seconds: ((Date.now() - t0) / 1000).toFixed(1), seq: [before?.seq, after.seq], reason: after.value.reason } : 'still connected after 30 s')
  const seenOrbit = await look(rig, p, 'orbit', 'parked')
  p.check('orbit: the desk shows the OpenRouter remedy', seenOrbit.ok && (seenOrbit.value?.freezeText ?? []).some(t => /replace the OpenRouter key in App settings → Providers, then resume/.test(t)),
    seenOrbit.ok ? seenOrbit.value.freezeText : seenOrbit.error)

  // ---------------------------------------------------------------- orbit2: the fourth 402 in a row
  // three refusals already counted (each would otherwise wait out a 5-minute probe)
  rig.exec(`UPDATE ot.agents SET extra = jsonb_set(extra, '{balance_probe_run}', '3') WHERE name = 'orbit2'`)
  await rig.userMail('orbit2', 'PROOF-OR-402: please try.')
  const parked2 = await rig.waitFor(() => rig.agentRow('orbit2')?.frozen ?? null, { what: 'orbit2 to be parked', timeout: 60000 })
  p.check('orbit2: the fourth balance refusal in a row → parked (cause balance)', parked2.cause === 'balance' && parked2.parked === true, parked2)
  p.check('orbit2: `until` names the balance remedy (3.x shape)',
    parked2.until === 'balance refused 4 turns running — check balance or in-flight requests, then resume manually', parked2.until)
  const seenOrbit2 = await look(rig, p, 'orbit2', 'parked')
  p.check('orbit2: the desk shows the balance remedy', seenOrbit2.ok && (seenOrbit2.value?.freezeText ?? []).some(t => /check balance or in-flight requests, then resume manually/.test(t)),
    seenOrbit2.ok ? seenOrbit2.value.freezeText : seenOrbit2.error)

  // ---------------------------------------------------------------- a key check with fewer fields
  keyCheck(rig.data, { status: 200, data: { label: 'rig key', usage: 1.5 } })
  const sparse = await rig.api('GET', '/api/openrouter?force=true').then(v => ({ ok: true, v }), e => ({ ok: false, e: e.message }))
  p.check('a key check without credit fields: the panel document answers, connected, the missing fields null', sparse.ok
    && sparse.v.connected === true && sparse.v.credits?.total_credits === null && sparse.v.credits?.usage === 1.5, sparse.ok ? sparse.v.credits : sparse.e)
  const alive = await rig.api('GET', '/api/app/records').then(() => true, () => false)
  p.check('the engine still answers after that check', alive)

  p.keep(rig, { agents: ['orbit', 'orbit2'], grep: /orbit|openrouter|freeze|frozen|parked|401|402|panic/i })
  return p.summary()
}
