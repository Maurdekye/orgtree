// projectform.test.tsx — A PROJECT'S LONG FORM (USER 2026-10-27
// md30a04a62550: "doesnt work for projects though", after mbb80ce47f2c4 showed
// @agent:orgtree/coordinator-opus already rendering as an agent mention).
// `@project:<org>/<name>` renders and clicks like the plain project mention;
// a name that is not a live project here (build-slots, or an agent's) stays
// plain text, as an unknown `@name` does; another org's keeps its chip.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs projectform
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { linkifyRefs, refClickHandler } from '../src/canvas/refmd'
import { refToken, splitTypedRefs } from '../src/canvas/reflinks'
import { scanRefs } from '../src/canvas/workrefs'
import { md } from '../src/canvas/shared'
import type { RefWorld } from '../src/canvas/reflinks'

const world: RefWorld = {
  org: 'org',
  agents: new Map([['worker-alpha', 'worker-alpha'], ['build-slot', 'build-slot']]),
  tierOf: (id) => id === 'build-slot' ? 'project' : 'haiku',
}

test('the grammar reads the project form as a node reference that must name a project', () => {
  const [hit] = scanRefs('see @project:org/build-slot.')
  assert.deepEqual(hit!.ref, { kind: 'agent', org: 'org', id: 'build-slot', as: 'project' })
  assert.equal(hit!.token, '@project:org/build-slot')
  assert.equal(refToken(hit!.ref), '@project:org/build-slot', 'the copied token keeps the form it was written in')
  assert.equal(scanRefs('x@project:org/build-slot').length, 0, 'embedded in a word: not a reference')
  assert.equal(scanRefs('@project:org/a@project:org/b').length, 2, 'two adjacent references both survive')
})

test('plain text: a live project is a project chip; an unknown or agent name stays as written; another org keeps its chip', () => {
  const text = 'ask @project:org/build-slot, not @project:org/build-slots or @project:org/worker-alpha; elsewhere @project:other/x'
  const runs = splitTypedRefs(text, world)
  assert.equal(runs.map(r => r.text).join(''), text, 'lossless')
  const refs = runs.filter(r => r.ref).map(r => [r.text, r.ref!.outcome, r.ref!.tier ?? null])
  assert.deepEqual(refs, [['@project:org/build-slot', 'ready', 'project'], ['@project:other/x', 'foreign', null]])
  assert.ok(runs.some(r => !r.ref && r.text.includes('@project:org/build-slots')), 'a nonexistent name is plain text')
  assert.ok(runs.some(r => !r.ref && r.text.includes('@project:org/worker-alpha')), 'an agent is not a project')
})

test('Markdown: the project form is the project mention, with its folder mark, and clicks to the project', () => {
  const host = document.createElement('div')
  host.innerHTML = md('Ask @project:org/build-slot or the plain @build-slot; @project:org/build-slots stays.').__html
  linkifyRefs(host, world)
  const chips = [...host.querySelectorAll<HTMLElement>('[data-agent-nav="build-slot"]')]
  assert.equal(chips.length, 2, 'the long and the plain form both link the project')
  assert.ok(chips.every(c => c.querySelector('.project-mark')), 'both wear the project folder mark')
  assert.ok(host.textContent!.includes('@project:org/build-slots stays.'), 'the nonexistent one is left as written')
  assert.equal(host.querySelectorAll('[data-agent-nav]').length, 2)
  const opened: string[] = []
  host.addEventListener('click', refClickHandler(() => world, r => { opened.push(r.ref.id) }))
  chips[0]!.click()
  assert.deepEqual(opened, ['build-slot'])
})
