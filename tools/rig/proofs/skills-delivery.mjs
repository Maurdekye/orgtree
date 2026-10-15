// Transport/configuration proof, not a claim of real provider skill invocation.
// Every CLI is the rig fake. Read the emitted native paths and preserve resources.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

export async function setup() { return { ...(await keysSetup()), name: 'skills-delivery' } }

export default async function (rig) {
  const p = new Proof('skills-delivery')
  const home = path.join(rig.data, 'rig-home')
  const source = path.join(home, '.claude/skills/shared-delivery')
  fs.mkdirSync(path.join(source, 'references'), { recursive: true })
  const update = text => fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: shared-delivery\ndescription: Shared delivery fixture\n---\n${text}\n[resource](references/fixture.txt)\n`)
  update('SKILLS VERSION ONE')
  fs.writeFileSync(path.join(source, 'references/fixture.txt'), 'BUNDLED RESOURCE')
  const refresh = () => rig.api('POST', '/api/skills/refresh').catch(() => ({}))
  await refresh()
  rig.scenario({ agents: { skillclaude: { turns: [{ name: 'held', match: 'SKILLS-HOLD', once: true,
    steps: [{ text: 'Holding a turn.' }, { sleep_ms: 32000 }, { text: 'Done.' }] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(async () => !(await rig.api('GET', '/api/providers')).checking, { what: 'discovery', timeout: 30000 })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-1', { harness: 'opencode' })
  const lanes = [['skillclaude', 'haiku'], ['skillcodex', 'luna'], ['skillagy', 'flash'], ['skillmuse', 'wonder'], ['skilloc', 'or-rig-fake-model']]
  const scratch = name => rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${rig.agentRow(name).id}`).scratch_dir
  const starts = name => rig.fakeLog(name).filter(x => x.kind === 'start')
  const turn = async (name, text) => {
    const count = rig.turns(name).filter(x => x.ended_at).length
    await rig.userMail(name, text)
    await rig.waitTurns(name, count + 1)
  }
  const oc = name => {
    try { return fs.readFileSync(path.join(scratch(name), 'acp-observed.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).at(-1) }
    catch { return null }
  }
  const root = name => {
    if (name === 'skillclaude') return starts(name).at(-1)?.add_dirs?.find(x => x.replaceAll('\\', '/').includes('/shared-skills/')) &&
      path.join(starts(name).at(-1).add_dirs.find(x => x.replaceAll('\\', '/').includes('/shared-skills/')), '.claude', 'skills', 'shared-delivery')
    if (name === 'skillcodex') {
      const call = rig.fakeLog(name).filter(x => x.kind === 'recv' && x.line?.method === 'skills/extraRoots/set').at(-1)
      return call?.line?.params?.extraRoots?.[0] && path.join(call.line.params.extraRoots[0], 'shared-delivery')
    }
    if (name === 'skilloc') return oc(name)?.skills?.[0] && path.join(oc(name).skills[0], 'shared-delivery')
    return path.join(scratch(name), '.agents', 'skills', 'orgtree-shared-delivery')
  }
  const read = (name, file = 'SKILL.md') => { try { return fs.readFileSync(path.join(root(name), file), 'utf8') } catch { return '' } }
  const first = new Map()
  for (const [name, tier] of lanes) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier, title: 'Shared skills fixture', grant: 1 })
    await turn(name, 'SKILLS-FIRST')
    const bytes = read(name)
    p.check(`${name}: native launch binding exposes instructions and relative resource`, bytes.includes('SKILLS VERSION ONE') && read(name, 'references/fixture.txt') === 'BUNDLED RESOURCE')
    first.set(name, { root: root(name), bytes })
  }
  p.check('OpenCode grants exact skill loading without granting arbitrary execute', oc('skilloc')?.skillPermissions?.some(r => r.resource === 'shared-delivery' && r.effect === 'allow'))
  const before = await refresh()
  const after = await refresh()
  for (const [name] of lanes) {
    await turn(name, 'SKILLS-UNCHANGED')
    const old = first.get(name)
    p.check(`${name}: unchanged refresh keeps native path and instruction bytes`, !!before.digest && before.digest === after.digest && !!old.root && root(name) === old.root && read(name) === old.bytes)
  }
  const n = rig.turns('skillclaude').filter(x => x.ended_at).length
  await rig.userMail('skillclaude', 'SKILLS-HOLD')
  await rig.waitFor(() => rig.fakeLog('skillclaude').some(x => x.kind === 'step' && x.step?.sleep_ms === 32000), { what: 'held Claude turn', timeout: 30000 })
  const count = starts('skillclaude').length
  const pid = starts('skillclaude').at(-1)?.pid
  update('SKILLS VERSION TWO')
  const changed = await refresh()
  // Span the actor's idle recheck interval: refresh must not rewrite active inputs.
  await new Promise(resolve => setTimeout(resolve, 22000))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch {}
  p.check('refresh leaves the active turn and its immutable snapshot untouched', !!changed.digest && changed.digest !== before.digest &&
    alive && starts('skillclaude').length === count && rig.turns('skillclaude').some(x => !x.ended_at) && read('skillclaude') === first.get('skillclaude').bytes)
  await rig.waitTurns('skillclaude', n + 1)
  for (const [name] of lanes) {
    await turn(name, 'SKILLS-CHANGED')
    p.check(`${name}: changed instructions arrive at the next turn boundary`, read(name).includes('SKILLS VERSION TWO'))
  }
  p.check('native source content was never overwritten', fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8').includes('name: shared-delivery\n'))
  p.keep(rig, { agents: lanes.map(([name]) => name) })
  return p.summary()
}
