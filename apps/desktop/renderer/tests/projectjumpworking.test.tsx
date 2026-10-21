import { mountView, inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NavChip } from '../src/canvas/desk'
import { agent, project } from './projectbunch-fixture'
import { workingTree } from './projectjumpworking-fixture'
import type { CanvasNode } from '../src/canvas/shared'

for (const dir of ['up', 'down'] as const) {
  test(`${dir} project jump chip follows live descendant turns through projects and agents`, async () => {
    let target = ''
    const chip = (n: CanvasNode) => <NavChip n={n} dir={dir} onJump={id => { target = id }} />
    const view = await mountView(chip(workingTree()), el => el)
    try {
      assert.equal(view.el.querySelectorAll('.cc-spin').length, 1, 'a deep busy agent activates its project')
      assert.equal(view.el.querySelectorAll('.project-mark').length, 1, 'project keeps its folder identity')
      await inAct(() => view.el.querySelector<HTMLButtonElement>('.desk-nav-chip')!.click())
      assert.equal(target, 'shader-project', 'activity does not change navigation')
      await view.render(chip(workingTree(false)))
      assert.equal(view.el.querySelectorAll('.cc-spin').length, 0, 'turn completion removes the spinner')
      await view.render(chip(workingTree()))
      assert.equal(view.el.querySelectorAll('.cc-spin').length, 1, 'a later turn restores it')
    } finally { await view.unmount() }
  })
}

test('project chips ignore retired agents, bearer ghosts, project flags and reported Working status', async () => {
  const root = project('idle-project', [
    { ...agent('retired'), state: 'archived', busy: true },
    { ...agent('ghost'), isBearerOf: 'old-agent', busy: true },
    { ...agent('reported'), busy: false, last_status: { status: 'working', summary: '', at: '' } },
    { ...project('empty-project'), busy: true },
  ]) as CanvasNode
  const view = await mountView(<NavChip n={root} dir="down" onJump={() => {}} />, el => el)
  try { assert.equal(view.el.querySelectorAll('.cc-spin').length, 0) }
  finally { await view.unmount() }
})

test('agent jump chips keep their own turn signal without aggregating reports', async () => {
  const root = { ...agent('idle-manager', [{ ...agent('busy-report'), busy: true }]), busy: false } as CanvasNode
  const view = await mountView(<NavChip n={root} dir="down" onJump={() => {}} />, el => el)
  try {
    assert.equal(view.el.querySelectorAll('.cc-spin').length, 0)
    await view.render(<NavChip n={{ ...root, busy: true }} dir="down" onJump={() => {}} />)
    assert.equal(view.el.querySelectorAll('.cc-spin').length, 1)
  } finally { await view.unmount() }
})
