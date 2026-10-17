// Baseline-red full-process proof, written before Muse persistence changes.
// Fake metadata emits a dated reading, then no reading across engine restarts.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const observedMs = Date.now() - 2 * 3600e3
const observed = new Date(observedMs).toISOString()
const raw = (session, weekly, reset = Date.now() + 3600e3, at = observedMs) => ({ usage: {
  observedAtMs: at,
  window: { usedPercent: session, windowDurationMins: 300, resetsAtMs: reset },
  weekly: { usedPercent: weekly, resetsAtMs: Date.now() + 2 * 86400e3 },
  private_sentinel: 'muse-cache-must-not-save-raw-fields',
} })
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}
export async function setup() {
  return { fixture: { org: { name: 'Muse restart cache' },
    agents: [{ name: 'rhea', tier: 'sol', grant: 2 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } },
    prepare: async ({ dir }) => write(path.join(dir, 'fakecli', 'muse-usage.json'), raw(57, 73, Date.now() - 3600e3)) }
}

export default async function (rig) {
  const p = new Proof('muse-usage-restart')
  const ownFixture = path.join(rig.fakeDir, 'muse-usage.json')
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find(x => x.id === 'muse' && x.muse?.catalog),
    { what: 'fake Muse discovery', timeout: 60000 })
  const before = await rig.api('GET', '/api/muse/usage?force=true')
  p.check('control: fake metadata supplies original dated good reading', before.available === true
    && before.observed_at === observed && before.limits?.find(w => w.group === 'weekly')?.percent === 73, before)
  p.check('fresh account identity is shown even when the quota observation repeats', before.email === 'rig@example.invalid', before.email)
  const id = (await rig.api('POST', '/api/accounts', { provider: 'muse', kind: 'managed' })).id
  const root = rig.one(`SELECT config_dir FROM ot.accounts WHERE id = '${id}'`)?.config_dir
  if (!root) throw Error('managed Muse fixture has no config_dir')
  const profileFixture = path.join(root, 'config', 'muse-usage.json')
  const secondaryObserved = new Date(observedMs + 1000).toISOString()
  write(profileFixture, raw(83, 91, Date.now() + 3600e3, observedMs + 1000))
  const profile = await rig.api('GET', `/api/accounts/${id}/usage?force=true`)
  p.check('control: registered account has its own dated reading', profile.available === true
    && profile.observed_at === secondaryObserved && profile.limits?.find(w => w.group === 'weekly')?.percent === 91, profile)
  const saved = () => rig.sql("SELECT key,value FROM ot.kv WHERE key LIKE 'muse_usage:%' ORDER BY key")
  const rows = saved()
  p.check('last-good readings are saved separately per account without raw private fields',
    rows.some(r => r.key === 'muse_usage:muse/primary') && rows.some(r => r.key === `muse_usage:${id}`)
      && !JSON.stringify(rows).includes('muse-cache-must-not-save-raw-fields'), rows)

  // The fake provider knows nothing after restart. No Muse turn is run.
  write(ownFixture, { usage: null })
  write(profileFixture, { usage: null })
  await rig.restart()
  const restored = await rig.api('GET', '/api/muse/usage')
  const secondary = await rig.api('GET', `/api/accounts/${id}/usage`)
  p.check('restart retains primary last-good reading when Muse reports none', restored.available === true
    && restored.limits?.find(w => w.group === 'weekly')?.percent === 73, restored)
  p.check('restart preserves true observation time and stale age', restored.observed_at === observed
    && Date.now() - Date.parse(restored.observed_at) >= 2 * 3600e3, restored.observed_at)
  const expired = restored.limits?.find(w => w.group === 'window')
  p.check('passed reset is unknown, never old percent or invented zero', !!expired
    && expired.percent === null && expired.is_active === null && Date.parse(expired.resets_at) < Date.now(), expired)
  p.check('registered account survives independently with its original age', secondary.available === true
    && secondary.observed_at === secondaryObserved && secondary.limits?.find(w => w.group === 'window')?.percent === 83, secondary)
  // Discovery establishes the native Muse lane's visibility after restart.
  // An immediate call before discovery tests admission, not cache staleness.
  await rig.waitFor(async () => (await rig.api('GET', '/api/providers'))?.providers?.find(x => x.id === 'muse' && x.muse?.catalog),
    { what: 'fake Muse rediscovery', timeout: 60000 })
  const identified = await rig.api('GET', '/api/muse/usage')
  p.check('metadata identity overlays restored quota when usage/read reports none',
    identified.email === 'rig@example.invalid' && identified.observed_at === observed, identified)
  const board = await rig.tool('rhea', 'orgtree_usage', { accounts: ['muse/primary', id] })
  const text = JSON.stringify(board)
  p.check('cached tool exposes original dates and stale freshness', text.includes(observed) && text.includes(secondaryObserved)
    && text.includes('stale'), board)
  // The usage tool intentionally returns quota fields only. Identity is
  // displayed in the turn's account roster, which consumes the same cache.
  const turns = rig.turns('rhea').filter(t => t.ended_at).length
  await rig.userMail('rhea', 'MUSE-IDENTITY-HEADER: answer OK.')
  await rig.waitTurns('rhea', turns + 1)
  const prompt = rig.fakeLog('rhea').filter(l => l.kind === 'turn').at(-1)?.prompt ?? ''
  const roster = (prompt.match(/\[ACCOUNTS\][^\n]*/) ?? [''])[0]
  p.check('turn account roster names the observed primary account after restart',
    prompt.includes('MUSE-IDENTITY-HEADER') && roster.includes('muse/primary (rig@example.invalid)'), roster)
  p.check('identity refresh does not enter durable quota or another profile', !JSON.stringify(saved()).includes('rig@example.invalid')
    && !secondary.email, { saved: saved(), secondary })

  write(path.join(rig.fakeDir, 'muse-account.json'), { state: 'accountLogin', label: '' })
  const unknownIdentity = await rig.api('GET', '/api/muse/usage?force=true')
  p.check('missing account label remains unknown without losing quota history', !unknownIdentity.email
    && unknownIdentity.observed_at === observed && unknownIdentity.limits?.find(w => w.group === 'weekly')?.percent === 73, unknownIdentity)
  write(path.join(rig.fakeDir, 'muse-account.json'), { state: 'accountLogin', label: 'rig@example.invalid' })

  // A newer genuine metadata observation replaces the cached one.
  const newerAt = Date.now() - 1000
  write(ownFixture, raw(22, 31, Date.now() + 3600e3, newerAt))
  const newer = await rig.api('GET', '/api/muse/usage?force=true')
  p.check('newer provider observation replaces restored reading', newer.observed_at === new Date(newerAt).toISOString()
    && newer.limits?.find(w => w.group === 'window')?.percent === 22, newer)
  write(ownFixture, { usage: null })
  const hadProfile = saved().some(r => r.key === `muse_usage:${id}`)
  await rig.api('DELETE', `/api/accounts/${id}`)
  p.check('account removal clears its durable reading while retaining primary', hadProfile
    && !saved().some(r => r.key === `muse_usage:${id}`) && saved().some(r => r.key === 'muse_usage:muse/primary'), saved())
  await rig.restart()
  const last = await rig.api('GET', '/api/muse/usage')
  p.check('second restart retains newer primary and does not resurrect removed account', last.observed_at === new Date(newerAt).toISOString()
    && last.limits?.find(w => w.group === 'window')?.percent === 22
    && !saved().some(r => r.key === `muse_usage:${id}`), { last, saved: saved() })
  p.keep(rig, { grep: /Muse usage|muse_usage|restored/ })
  return p.summary()
}
