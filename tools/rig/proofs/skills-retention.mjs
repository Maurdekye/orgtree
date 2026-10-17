// Synthetic scratch database and fake CLI only. Exercises real background
// cleanup, launch-token lifetime and durable session references across restart.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('skills-retention')
  const shared = path.join(rig.data, 'shared-skills')
  const source = path.join(rig.data, 'rig-home', '.claude/skills/retention-control/SKILL.md')
  const sqlText = s => `'${s.replaceAll("'", "''")}'`
  const normal = p => path.resolve(p.replace(/^\\\\\?\\/, '')).toLowerCase()
  const refresh = () => rig.api('POST', '/api/skills/refresh')
  const version = async n => {
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, `---\nname: retention-control\ndescription: Synthetic retention fixture\n---\nVERSION ${n}\n`)
    const result = await refresh()
    const root = path.join(shared, result.digest)
    await rig.waitFor(() => fs.existsSync(path.join(root, 'complete.json')), { what: `materialized version ${n}`, timeout: 15000, every: 100 })
    return root
  }
  const oldSnapshot = (digit, owned = true) => {
    const digest = digit.repeat(64)
    const dir = path.join(shared, digest)
    fs.mkdirSync(dir, { recursive: true })
    if (owned) fs.writeFileSync(path.join(dir, '.orgtree-skill.json'), JSON.stringify({ owner: 'orgtree-skills-v1' }))
    const complete = path.join(dir, 'complete.json')
    fs.writeFileSync(complete, JSON.stringify({ digest }))
    fs.writeFileSync(path.join(dir, 'canary.txt'), 'SYNTHETIC_SKILL_CONTENT_DO_NOT_LOG')
    const old = new Date(Date.now() - 600000)
    fs.utimesSync(complete, old, old)
    return dir
  }
  const removed = async (dir, label) => {
    await refresh()
    await rig.waitFor(() => !fs.existsSync(dir), { what: label, timeout: 15000, every: 100 })
  }
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

  const initial = await version(1)
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.op({ op: 'hire', name: 'skillkeeper', parent: 'boss', tier: 'haiku', title: 'Retention fixture', grant: 1 })
  await rig.userMail('skillkeeper', 'Keep the synthetic skill snapshot available.')
  await rig.waitTurns('skillkeeper', 1)
  const launch = rig.fakeLog('skillkeeper').filter(x => x.kind === 'start').at(-1)
  const row = rig.agentRow('skillkeeper')
  const binding = row.extra?.skill_snapshot
  const loaded = launch?.add_dirs?.find(x => x.replaceAll('\\', '/').includes('/shared-skills/'))
  p.check('launch records a durable session binding', binding?.known === true && binding.session === row.session_id && binding.paths?.some(x => normal(x) === normal(loaded ?? '')), binding)
  p.check('control: fake CLI is parked on the first snapshot', alive(launch?.pid) && normal(loaded ?? '') === normal(initial))

  // Keep the valid session marker, but remove its paths, to isolate the warm
  // process token from the durable-session mechanism in this scratch fixture.
  rig.exec(`UPDATE ot.agents SET extra=jsonb_set(extra,'{skill_snapshot,paths}','[]'::jsonb) WHERE id=${row.id}`)
  const previous = await version(2)
  const current = await version(3)
  const unused = oldSnapshot('a')
  const foreign = oldSnapshot('b', false)
  const stage = path.join(shared, '.stage-retention-proof')
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, '.orgtree-skill.json'), JSON.stringify({ owner: 'orgtree-skills-v1' }))
  const hourAgo = new Date(Date.now() - 7200000)
  fs.utimesSync(stage, hourAgo, hourAgo)
  await removed(unused, 'old unreferenced snapshot removal')
  p.check('warm-process token protects the old launch despite registry refresh', fs.existsSync(initial) && alive(launch?.pid))
  p.check('current and immediately previous complete snapshots stay', fs.existsSync(current) && fs.existsSync(previous))
  p.check('unowned snapshot remains untouched', fs.readFileSync(path.join(foreign, 'canary.txt'), 'utf8') === 'SYNTHETIC_SKILL_CONTENT_DO_NOT_LOG')
  await rig.waitFor(() => !fs.existsSync(stage), { what: 'abandoned stage removal', timeout: 15000, every: 100 })
  p.check('owned stage older than one hour is removed', !fs.existsSync(stage))

  rig.exec(`UPDATE ot.agents SET extra=jsonb_set(extra,'{skill_snapshot}',${sqlText(JSON.stringify(binding))}::jsonb) WHERE id=${row.id}`)
  await rig.restart()
  const afterRestart = oldSnapshot('c')
  await removed(afterRestart, 'post-restart cleanup completion')
  p.check('idle session binding protects snapshot after engine restart', fs.existsSync(initial) && rig.agentRow('skillkeeper').extra?.skill_snapshot?.session === row.session_id)
  await rig.op({ op: 'retire', node: 'skillkeeper' })
  await removed(initial, 'retired session snapshot removal')
  p.check('retiring the final referencing agent makes old snapshot removable', !fs.existsSync(initial))
  p.check('removal logs include metadata without skill contents', /removed unused shared skill snapshot/.test(rig.engineLog()) && !rig.engineLog().includes('SYNTHETIC_SKILL_CONTENT_DO_NOT_LOG'))
  p.keep(rig, { agents: ['skillkeeper'], grep: /shared skill|session skill/ })
  return p.summary()
}
