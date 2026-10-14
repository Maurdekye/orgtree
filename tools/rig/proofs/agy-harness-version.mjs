// Settings → Harnesses shows Antigravity's installed version even when its
// sign-in is refused or latched. Fake CLI and disposable vault metadata only.
// Red control: an engine that read the version only after a passing silent
// check reports no version after a restart into a refused sign-in.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

const FAKE_VERSION = '1.99.0 (Antigravity fake)'

export default async function (rig) {
  const p = new Proof('agy-harness-version')
  const metadata = value => fs.writeFileSync(path.join(rig.data, 'agy-auth-metadata.json'), JSON.stringify(value))
  const fixture = value => fs.writeFileSync(path.join(rig.fakeDir, 'agy-auth.json'), JSON.stringify(value))
  const calls = () => {
    try { return fs.readFileSync(path.join(rig.fakeDir, 'agy-auth-calls.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) }
    catch (e) { if (e.code === 'ENOENT') return []; throw e }
  }
  const discovered = () => rig.waitFor(async () => !(await rig.api('GET', '/api/providers')).checking,
    { what: 'discovery', timeout: 30000 })
  const harness = async () => (await rig.api('GET', '/api/harnesses')).harnesses.find(h => h.id === 'antigravity')

  fixture({ check: 'ok' }); metadata({ stamp: 50 })
  await rig.restart(); await discovered()
  let h = await harness()
  p.check('signed-in Antigravity lists its installed version', h?.installed && h.version === FAKE_VERSION, h)

  // Refused sign-in, fresh engine: nothing in memory to fall back on.
  fixture({ check: 'reject' }); metadata({ stamp: 51 })
  await rig.restart(); await discovered()
  h = await harness()
  p.check('refused sign-in still lists the installed version', h?.installed && h.version === FAKE_VERSION, h)
  const provider = (await rig.api('GET', '/api/providers')).providers.find(x => x.id === 'google')
  p.check('the version does not mark Antigravity connected', provider && !provider.status.connected, provider?.status)

  // Absent credential: no silent check may run, the version query still may.
  const before = calls().length
  metadata({ present: false })
  await rig.restart(); await discovered()
  h = await harness()
  const after = calls().slice(before)
  p.check('absent credential still lists the installed version', h?.version === FAKE_VERSION, h)
  p.check('without a credential only the version query launched: no check, usage or runtime',
    after.some(c => c.kind === 'version') && after.every(c => c.kind === 'version'), after)
  p.file('guard-calls.json', calls())
  return p.summary()
}
