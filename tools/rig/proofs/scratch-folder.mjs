import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('scratch-folder')
  const route = node => `/api/orgs/${rig.org}/nodes/${node}/scratch-folder`
  const get = node => rig.api('GET', route(node))
  const quote = s => `'${s.replaceAll("'", "''")}'`
  const native = process.env.PROOF_SCRATCH_NATIVE_BUNDLE
    ? createRequire(import.meta.url)(process.env.PROOF_SCRATCH_NATIVE_BUNDLE).openAgentScratchFolder : null
  const opened = []
  const open = node => native({ origin: rig.url, token: rig.token }, rig.org, node,
    async directory => { opened.push(directory); return '' })
  const stored = rig.one("SELECT scratch_dir FROM ot.agents WHERE name = 'alice'").scratch_dir
  p.check('stored scratch path', (await get('alice')).path === stored)
  await rig.op({ op: 'rename', node: 'alice', name: 'alice-renamed' })
  p.check('rename keeps stored scratch path', (await get('alice-renamed')).path === stored)
  const custom = path.join(rig.data, 'imported custom folder & name')
  fs.mkdirSync(custom)
  rig.exec(`UPDATE ot.agents SET scratch_dir = ${quote(custom)} WHERE name = 'alice-renamed'`)
  await rig.op({ op: 'retire', node: 'alice-renamed' })
  p.check('archived agent uses custom/imported stored path', (await get('alice-renamed')).path === custom)
  if (native) p.check('native directory action opens authoritative archived folder through real endpoint',
    (await open('alice-renamed')).ok && opened[0] === fs.realpathSync(custom))
  const missing = path.join(rig.data, 'missing scratch folder')
  rig.exec(`UPDATE ot.agents SET scratch_dir = ${quote(missing)} WHERE name = 'bob'`)
  p.check('metadata lookup never creates a missing folder', (await get('bob')).path === missing && !fs.existsSync(missing))
  if (native) {
    p.check('native missing folder refuses without creation or launch', !(await open('bob')).ok && !fs.existsSync(missing) && opened.length === 1)
    const file = path.join(rig.data, 'replaced-scratch.exe')
    fs.writeFileSync(file, 'fixture')
    rig.exec(`UPDATE ot.agents SET scratch_dir = ${quote(file)} WHERE name = 'bob'`)
    p.check('native file in place of folder refuses without launch', !(await open('bob')).ok && opened.length === 1)
  }
  rig.exec("UPDATE ot.agents SET scratch_dir = NULL WHERE name = 'bob'")
  p.check('null scratch uses config fallback', (await get('bob')).path === path.join(rig.data, 'scratch', rig.org, 'bob'))
  rig.exec("UPDATE ot.agents SET state = 'deleted' WHERE name = 'bob'")
  p.check('deleted agent refused', await get('bob').then(() => false, () => true))
  p.check('unknown agent refused', await get('absent').then(() => false, () => true))
  const unauth = await fetch(rig.url + route('carol'))
  p.check('unauthenticated identity lookup refused', unauth.status === 401 || unauth.status === 403, unauth.status)
  return p.summary()
}
