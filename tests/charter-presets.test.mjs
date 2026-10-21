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

test('Heavy dev shop developers resolve the short combined author/reviewer preset', () => {
  const text = readFileSync(path.join(root, 'engine/docs/charters/developer.md'), 'utf8')
  assert.ok(text.length < 1800)
  assert.match(text, /assigned implementation and assigned/)
  assert.match(text, /peer review/)
  assert.doesNotMatch(text, /private worktree|red-first|exact SHA|same landing/)
  // Operational policy is inherited once; the preset remains a role summary.
  const template = JSON.parse(readFileSync(path.join(root, 'engine/docs/templates/heavy-dev-shop.json'), 'utf8'))
  const developers = template.agents[0].reports[0].reports[0].reports.filter(s => s.name.startsWith('developer-'))
  assert.equal(developers.length, 11)
  for (const seat of developers) assert.deepEqual(seat.charter, {preset: 'developer'})
  const coordinator = template.agents[0].reports[0]
  const project = coordinator.reports[0]
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
    ['private worktree', 'coordinator.team'],
    ['red-first', 'coordinator.team'],
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
  for (const requirement of [/exact SHA/, /independent checks/, /on the docket/, /never fix the author's product code in place/, /by mail/, /same landing/]) assert.match(coordinator.team_agents_md, requirement)
})
