import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const settingsFile = path.join(root, 'engine/rs/orgtree-engine/src/http/settings.rs')
const settings = readFileSync(settingsFile, 'utf8')
const bundled = settings.match(/const BUNDLED:[\s\S]*?= &\[([\s\S]*?)\];/)[1]
const entries = [...bundled.matchAll(/\("([^"]+)",\s*include_str!\("([^"]+)"\)\)/g)]

test('every shipped charter, including liaison and developer, is registered with its actual content file', () => {
  const files = readdirSync(path.join(root, 'engine/docs/charters')).filter(f => f.endsWith('.md')).sort()
  const registered = entries.map(([, name]) => name).sort()
  assert.ok(registered.includes('liaison.md'), 'the liaison must be selectable and populatable')
  assert.ok(registered.includes('developer.md'), 'the combined author/reviewer role must be selectable')
  assert.deepEqual(registered, files, 'bundled lookup/population must offer every shipped charter exactly once')
  for (const [, name, relative] of entries) {
    assert.equal(path.resolve(path.dirname(settingsFile), relative), path.join(root, 'engine/docs/charters', name))
    assert.ok(readFileSync(path.resolve(path.dirname(settingsFile), relative), 'utf8').trim())
  }
})

test('whole-file preset introductions describe the role without manual charter-copy instructions', () => {
  for (const [, name, relative] of entries) {
    const content = readFileSync(path.resolve(path.dirname(settingsFile), relative), 'utf8')
    const intro = content.split(/\r?\n---\r?\n/, 1)[0]
    assert.doesNotMatch(intro, /paste this|give this to|copy (?:this|it) into/i, name)
    assert.ok([...content].length <= 100_000, `${name} must fit the endpoint's full-content limit`)
  }
})


test('Developer is a complete standalone author and assigned-reviewer charter', () => {
  const text = readFileSync(path.join(root, 'engine/docs/charters/developer.md'), 'utf8')
  const plain = text.replace(/\s+/g, ' ')
  assert.ok(Buffer.byteLength(text) >= 2500 && Buffer.byteLength(text) <= 3100, 'standalone role should be comparable in size to Implementer and Redteam')
  for (const requirement of [/private worktree and branch/, /red-first focused tests/, /exact committed SHA and base/, /docs and glossary current in the same landing/, /assigned peer review/, /independent checks/, /findings or approval on the docket/, /never edit their worktree or product code in place/, /overlaps and dependencies with peers by mail/, /current review phase.*user waivers/, /role alone starts no review cycle or release/, /evidence measured or inferred/, /done or blocked.*orgtree_status/]) assert.match(plain, requirement)
  assert.doesNotMatch(text, /Heavy dev shop|Read the inherited AGENTS\.md files/)
})

test('Heavy dev shop inherits the standalone Developer without lower-note role duplication', () => {
  const text = readFileSync(path.join(root, 'engine/docs/charters/developer.md'), 'utf8')
  const template = JSON.parse(readFileSync(path.join(root, 'engine/docs/templates/heavy-dev-shop.json'), 'utf8'))
  const coordinator = template.agents[0].reports[0], project = coordinator.reports[0]
  const developers = project.reports.filter(s => s.name.startsWith('developer-'))
  assert.equal(developers.length, 11)
  for (const seat of developers) assert.deepEqual(seat.charter, {preset: 'developer'})
  const notes = { shared: template.shared_agents_md }
  function collect(slots) {
    for (const s of slots) {
      if (s.team_agents_md) notes[s.name + '.team'] = s.team_agents_md
      if (s.scratch_agents_md) notes[s.name + '.personal'] = s.scratch_agents_md
      collect(s.reports ?? [])
    }
  }
  collect(template.agents)
  assert.equal(Object.keys(notes).length, 7)
  const charters = [text, template.agents[0].team_charter]
  function roles(slots) { for (const s of slots) { if (s.charter?.text) charters.push(s.charter.text); roles(s.reports ?? []) } }
  roles(template.agents)
  const locations = { ...notes, charters: charters.join('\n'), summary: project.description }
  for (const [phrase, owner] of [
    ['Record user rulings verbatim', 'shared'],
    ['Label measured and inferred claims', 'shared'],
    ['Never serialize secrets', 'shared'],
    ['Leave no agent-owned background children', 'shared'],
    ['private worktree', 'charters'],
    ['red-first', 'charters'],
    ['independent checks', 'charters'],
    ['same landing', 'charters'],
    ['Only the coordinator or its explicitly assigned release owner integrates', 'coordinator.team'],
    ['orgtree_project action=release_slot', 'build-slot.team'],
    ['orgtree_staff', 'coordinator.personal'],
    ['self-contained coordinator briefs', 'liaison.personal'],
    ['inverted checks', 'test-rig.personal'],
    ['re-checkable citations', 'curator.personal']
  ]) {
    assert.ok(locations[owner].includes(phrase), phrase + ' must remain in its canonical file')
    assert.equal(Object.values(locations).reduce((n, s) => n + s.split(phrase).length - 1, 0), 1, phrase + ' must not repeat in lower notes, summaries or charters')
  }
  const lower = Object.entries(notes).filter(([name])=>name!=='shared').map(([,s])=>s).join('\n')
  assert.doesNotMatch(lower, /For assigned peer review inspect|never fix the author's product code in place|Coordinate overlaps and dependencies with peers by mail/)
  // Universal reporting remains shared for non-developer roles; a standalone
  // preset's essential reporting overlap is explicitly accepted, not moved away.
  assert.match(notes.shared, /Report done or blocked through orgtree_status/)
  assert.match(notes.shared, /Every hand-in names the exact SHA\/ref/)
})
