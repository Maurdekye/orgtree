import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('shared-scratch-folder')
  const root = path.join(rig.data, 'scratch', rig.org)
  const route = (node, scope) => `/api/orgs/${rig.org}/nodes/${encodeURIComponent(node)}/scratch-folder?scope=${scope}`
  const get = (node, scope) => rig.api('GET', route(node, scope))
  const id = rig.one("SELECT id FROM ot.agents WHERE name = 'carol'").id
  const team = path.join(root, '_teams', String(id)), shared = path.join(root, '_shared')
  // Only disposable rig data, never an installed org. Preserve pre-existing
  // notes; all staged names stay inside that synthetic org's scratch root.
  const saved = []
  for (const dir of [team, shared]) if (fs.existsSync(dir)) {
    const backup = dir + '-proof-original'
    if (fs.existsSync(backup)) throw new Error('fresh proof staging required')
    fs.renameSync(dir, backup); saved.push([dir, backup])
  }
  const native = process.env.PROOF_SCRATCH_NATIVE_BUNDLE
    ? createRequire(import.meta.url)(process.env.PROOF_SCRATCH_NATIVE_BUNDLE).openAgentScratchFolder : null
  try {
    p.check('leaf team uses numeric agent id and creates a missing own-led workspace',
      (await get('carol', 'team')).path === team && fs.statSync(team).isDirectory())
    p.check('repeat team resolution reuses the same directory', (await get('carol', 'team')).path === team)
    await rig.op({ op: 'rename', node: 'carol', name: 'team-leaf-renamed' })
    p.check('rename keeps numeric own-team identity', (await get('team-leaf-renamed', 'team')).path === team)
    await rig.op({ op: 'retire', node: 'team-leaf-renamed' })
    p.check('archived own-led team remains available', (await get('team-leaf-renamed', 'team')).path === team)
    p.check('org shared resolver creates its missing configured directory',
      (await get('_shared', 'shared')).path === shared && fs.statSync(shared).isDirectory())
    p.check('org shared resolution is idempotent', (await get('_shared', 'shared')).path === shared)
    if (native) {
      const opened = []
      const open = async dir => { opened.push(dir); return '' }
      p.check('production native helper opens the engine-resolved own team',
        (await native({ origin: rig.url, token: rig.token }, rig.org, 'team-leaf-renamed', open, 'team')).ok
        && opened[0] === fs.realpathSync(team))
      p.check('production native helper opens the same shared org directory',
        (await native({ origin: rig.url, token: rig.token }, rig.org, '', open, 'shared')).ok
        && opened[1] === fs.realpathSync(shared))
    } else throw new Error('PROOF_SCRATCH_NATIVE_BUNDLE required for native integration checks')
    p.check('unknown team owner refused', await get('absent', 'team').then(() => false, e => e.status === 404))
    p.check('org scope refuses a conflicting agent identity', await get('alice', 'shared').then(() => false, e => e.status === 422))
    p.check('unknown scope refused', await get('alice', 'outside').then(() => false, e => e.status === 400 || e.status === 422))
    const other = await rig.api('POST', '/api/orgs', { name: 'Other Shared Scratch', dirs: [], net_autoconnect: false })
    p.check('agent team identity is organization scoped', await rig.api('GET',
      `/api/orgs/${other.slug}/nodes/team-leaf-renamed/scratch-folder?scope=team`).then(() => false, e => e.status === 404))
    const unauth = await fetch(rig.url + route('_shared', 'shared'))
    p.check('shared directory lookup requires desktop authentication', unauth.status === 401 || unauth.status === 403)

    // Missing team leaves must not follow a junction/symlink out of the org.
    fs.rmdirSync(team)
    const outside = path.join(rig.data, 'outside-team-target')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, team, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      p.check('linked team leaf refuses before returning an outside directory',
        await get('team-leaf-renamed', 'team').then(() => false, e => e.status === 422))
      p.check('outside target remains untouched', fs.readdirSync(outside).length === 0)
    } finally { fs.unlinkSync(team) }
    fs.writeFileSync(team, 'not a directory')
    try {
      p.check('file replacing team directory refused', await get('team-leaf-renamed', 'team').then(() => false, e => e.status === 422))
    } finally { fs.unlinkSync(team) }
  } finally {
    for (const [dir, backup] of saved) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir) // newly created directory is empty
      fs.renameSync(backup, dir)
    }
  }
  return p.summary()
}
