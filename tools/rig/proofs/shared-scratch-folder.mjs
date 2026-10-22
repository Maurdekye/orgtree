import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { Proof } from '../proof.mjs'

// Preserve files and links without following them or assuming initialized
// workspaces are empty. All parked paths remain in the disposable rig.
export function scratchStaging() {
  const entries = [], parked = []
  const stat = file => { try { return fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  const snapshot = file => {
    const info = stat(file)
    if (!info) return null
    if (info.isSymbolicLink()) return { link: fs.readlinkSync(file) }
    if (info.isDirectory()) return { children: fs.readdirSync(file).sort().map(name => [name, snapshot(path.join(file, name))]) }
    if (info.isFile()) return { bytes: fs.readFileSync(file).toString('base64') }
    throw new Error(`unsupported scratch entry: ${file}`)
  }
  const park = dir => {
    const before = snapshot(dir)
    if (before === null) return
    const target = `${dir}-proof-staged-${parked.length}`
    if (stat(target)) throw new Error(`fresh proof staging required: ${target}`)
    fs.renameSync(dir, target)
    parked.push({ from: dir, path: target, snapshot: before })
  }
  return {
    stage(dir) {
      const before = snapshot(dir), backup = dir + '-proof-original'
      if (stat(backup)) throw new Error(`fresh proof staging required: ${backup}`)
      if (before !== null) fs.renameSync(dir, backup)
      entries.push({ dir, backup: before === null ? null : backup, before })
    },
    park,
    restore() {
      const restored = [], errors = []
      // Attempt every restore; one cleanup error must not hide the first
      // failure or prevent the other workspace's notes being put back.
      for (const entry of entries) {
        try {
          park(entry.dir)
          if (entry.backup) fs.renameSync(entry.backup, entry.dir)
          const after = snapshot(entry.dir)
          if (JSON.stringify(after) !== JSON.stringify(entry.before)) throw new Error('scratch restore differs from original bytes')
          restored.push({ ...entry, after })
        } catch (error) { errors.push({ ...entry, error: error.message, stack: error.stack }) }
      }
      return { restored, parked, errors }
    },
  }
}

export default async function (rig) {
  const p = new Proof('shared-scratch-folder')
  const staging = scratchStaging()
  let phase = 'setup'
  try {
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  p.note('source binary provenance', { engine: rig.run.engineSource, engineSha256: hash(rig.run.engineSource),
    nativeBundleSha256: process.env.PROOF_SCRATCH_NATIVE_BUNDLE ? hash(process.env.PROOF_SCRATCH_NATIVE_BUNDLE) : null })
  const root = path.join(rig.data, 'scratch', rig.org)
  const route = (node, scope) => `/api/orgs/${rig.org}/nodes/${encodeURIComponent(node)}/scratch-folder?scope=${scope}`
  const get = (node, scope) => rig.api('GET', route(node, scope))
  const id = rig.one("SELECT id FROM ot.agents WHERE name = 'carol'").id
  const team = path.join(root, '_teams', String(id)), shared = path.join(root, '_shared')
  // Only disposable rig data, never an installed org. Preserve pre-existing
  // notes; all staged names stay inside that synthetic org's scratch root.
  for (const dir of [team, shared]) staging.stage(dir)
  const native = process.env.PROOF_SCRATCH_NATIVE_BUNDLE
    ? createRequire(import.meta.url)(process.env.PROOF_SCRATCH_NATIVE_BUNDLE).openAgentScratchFolder : null
    phase = 'folder resolution, native helper and access guards'
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
    phase = 'junction and file boundaries'
    staging.park(team)
    const outside = path.join(rig.data, 'outside-team-target')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, team, process.platform === 'win32' ? 'junction' : 'dir')
      p.check('linked team leaf refuses before returning an outside directory',
        await get('team-leaf-renamed', 'team').then(() => false, e => e.status === 422))
      p.check('outside target remains untouched', fs.readdirSync(outside).length === 0)
    staging.park(team)
    fs.writeFileSync(team, 'not a directory')
      p.check('file replacing team directory refused', await get('team-leaf-renamed', 'team').then(() => false, e => e.status === 422))
  } catch (error) {
    p.check(`shared-scratch-folder failed during ${phase}`, false, { error: error.message, stack: error.stack })
  } finally {
    const restoration = staging.restore()
    p.file('scratch-restoration.json', restoration)
    for (const error of restoration.errors) p.check('shared-scratch-folder cleanup failed', false, error)
  }
  return p.summary()
}
