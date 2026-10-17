// Synthetic native-delivery proof: real engine, scratch DB, fake CLIs only.
// Checks the library at the paths each fake receives, not provider model choice.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'
import { REPO } from '../lib.mjs'
import { setup as keysSetup } from './openrouter-keys.mjs'

export async function setup() { return { ...(await keysSetup()), name: 'instructions-trim-skills' } }

const CATEGORIES = ['orgtree-working', 'orgtree-app', 'orgtree-workflows']
const read = file => fs.readFileSync(file, 'utf8')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const links = file => [...read(file).matchAll(/\]\(([^)]+\/SKILL\.md)\)/g)]
  .map(m => path.resolve(path.dirname(file), m[1]))
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])

export default async function (rig) {
  const p = new Proof('instructions-trim-skills')
  p.note('Synthetic binding and resource-read proof only. No real harness, auth, model invocation or model-obedience claim.')
  fs.writeFileSync(path.join(rig.fakeDir, 'probe-builtin-skills'), '')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(async () => !(await rig.api('GET', '/api/providers')).checking,
    { what: 'discovery', timeout: 30000 })
  await rig.api('PUT', '/api/openrouter/keys/openrouter-1', { harness: 'opencode' })
  const lanes = [['trimclaude', 'haiku'], ['trimcodex', 'luna'], ['trimagy', 'flash'],
    ['trimmuse', 'wonder'], ['trimoc', 'or-rig-fake-model']]
  const scratch = name => rig.one(`SELECT scratch_dir FROM ot.agents WHERE id=${rig.agentRow(name).id}`).scratch_dir
  const receipts = []
  for (const [name, tier] of lanes) {
    await rig.op({ op: 'hire', name, parent: 'boss', tier, title: 'Built-in library fixture', grant: 1 })
    await rig.userMail(name, 'TRIM-SKILLS-FIRST')
    await rig.waitTurns(name, 1)
    let root, binding
    if (name === 'trimclaude') {
      binding = rig.fakeLog(name).find(x => x.kind === 'start')?.add_dirs
        ?.find(x => x.replaceAll('\\', '/').includes('/shared-skills/'))
      root = binding && path.join(binding, '.claude/skills')
    } else if (name === 'trimcodex') {
      binding = rig.fakeLog(name).find(x => x.kind === 'recv' && x.line?.method === 'skills/extraRoots/set')?.line
      root = binding?.params?.extraRoots?.[0]
      const calls = rig.fakeLog(name).filter(x => x.kind === 'recv').map(x => x.line?.method)
      p.check(`${name}: skill roots sent before thread start`, calls.indexOf('skills/extraRoots/set') >= 0 &&
        calls.indexOf('skills/extraRoots/set') < calls.indexOf('thread/start'))
    } else if (name === 'trimoc') {
      binding = read(path.join(scratch(name), 'acp-observed.jsonl')).trim().split(/\r?\n/).map(JSON.parse).at(-1)
      root = binding?.skills?.[0]
      p.check(`${name}: exact category skill permissions`, CATEGORIES.every(category =>
        binding?.skillPermissions?.some(r => r.resource === category && r.effect === 'allow')))
    } else {
      binding = { cwd: scratch(name) }
      root = path.join(binding.cwd, '.agents/skills')
    }
    p.check(`${name}: native discovery root delivered`, !!root && fs.existsSync(root), { root })
    let observed
    try { observed = read(path.join(scratch(name), 'skills-observed.jsonl')).trim().split(/\r?\n/).map(JSON.parse).at(-1) } catch {}
    p.check(`${name}: fake agent opened category, section and leaf from native binding`,
      observed?.pid > 0 && CATEGORIES.every(category => observed.loaded?.some(r =>
        r.name === category && r.entry_bytes > 0 && r.section_bytes > 0 && r.leaf_bytes > 0 &&
        r.entry_bytes === fs.statSync(r.entry).size && r.section_bytes === fs.statSync(r.section).size &&
        r.leaf_bytes === fs.statSync(r.leaf).size)), observed)
    p.file(`${name}-reader.json`, observed ?? { missing: true })
    if (!root || !fs.existsSync(root)) continue
    const categories = fs.readdirSync(root).filter(n => fs.existsSync(path.join(root, n, 'SKILL.md')))
    p.check(`${name}: only the three built-in categories advertised`,
      categories.length === CATEGORIES.length && CATEGORIES.every(n => categories.includes(n)), categories)
    for (const category of CATEGORIES) {
      const entry = path.join(root, category, 'SKILL.md')
      const sections = links(entry)
      const canonical = path.join(REPO, 'docs/skills', category)
      // The first link's parent is the resource root; no assumed digest/path layout.
      const resources = sections[0] && path.dirname(path.dirname(sections[0]))
      const sourceFiles = files(canonical).filter(f => path.relative(canonical, f) !== 'SKILL.md')
      const missing = sourceFiles.filter(f => {
        const delivered = resources && path.join(resources, path.relative(canonical, f))
        return !delivered || !fs.existsSync(delivered) || hash(delivered) !== hash(f)
      }).map(f => path.relative(canonical, f))
      p.check(`${name}: ${category} complete resource bytes`, sourceFiles.length > 0 && missing.length === 0,
        { files: sourceFiles.length, missing })
      const leaves = sections.flatMap(section => links(section).filter(f => f !== path.join(resources, 'SKILL.md')))
      p.check(`${name}: ${category} category -> section -> leaf loads`, sections.length > 0 && leaves.length > 0 &&
        leaves.every(f => fs.existsSync(f) && /^name: orgtree-/m.test(read(f))),
      { sections: sections.length, leafLinks: leaves.length })
      receipts.push({ lane: name, category, entry, resources, resourceFiles: sourceFiles.length,
        sections: sections.length, leafLinks: leaves.length, missing })
    }
    p.file(`${name}-binding.json`, binding)
  }
  p.file('library-receipts.json', receipts)
  p.keep(rig, { agents: lanes.map(([name]) => name) })
  return p.summary()
}
