import { FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import { closeDraftSettings } from './draftclose.fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useState } from 'react'
import { DraftNode, type DraftForm } from '../src/canvas/cards'
import type { DraftScope } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const tree = { slug: 'draft-autosave', roots: [], dirs: [], tiers: { opus: 5 },
  default_tools: { bash: true, edit: true, web: true, subagents: true, mcp: [] },
  default_visibility: 'team', default_top_grant: 12, max_top_grant: 100,
  cascade_hire: true, audiences: [], audience_requests: [], credit_requests: [],
} as unknown as TreePayload

async function click(element: Element | null) {
  assert.equal(element !== null, true, 'required control exists')
  await inAct(async () => { (element as HTMLElement).click(); await flush() })
}

test('draft gear persists each change without Apply, stays open, and reopens the saved proposal before Hire', async t => {
  useFakeClock(); installFetch(new FakeServer())
  let staged: DraftForm | undefined
  const hired: (DraftScope | null)[] = []
  let cancelled = 0
  function Fixture() {
    const [form, setForm] = useState<DraftForm>({ name: 'proposed-agent', charter: 'Standing task',
      grant: 12, chosen: [], scope: null })
    staged = form
    return <DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'opus' }}
      map={new Map()} tree={tree} seats={tree.tiers!} maxTop={100} defaultTop={12}
      zoom={1} pxc={1} form={form} onFormChange={setForm}
      onConfirm={(_name, _grant, _charter, scope) => hired.push(scope)} onCancel={() => { cancelled++ }} />
  }
  const view = await mountView(<Fixture />, el => el)
  t.after(async () => { await view.unmount(); realClock() })
  await click(view.el.querySelector('.df-gear'))
  const panel = () => document.querySelector('.settings')!
  await click(panel().querySelector('[aria-label="Disabled by Orgtree"]'))
  assert.equal(staged?.scope?.tools.orgtree_disabled, true, 'change reaches the owning draft immediately')
  assert.equal(document.querySelector('.settings') !== null, true, 'saving keeps the menu open')
  assert.equal([...panel().querySelectorAll('button')].some(b => /^(?:apply|save)$/i.test(b.textContent?.trim() ?? '')), false)
  const visibility = panel().querySelector<HTMLSelectElement>('[aria-label="Visible agents"]')!
  await inAct(async () => { visibility.value = 'self'; visibility.dispatchEvent(new Event('change', { bubbles: true })); await flush() })
  assert.equal(staged?.scope?.org_visibility, 'self')
  assert.equal(staged?.scope?.tools.orgtree_disabled, true, 'later edits preserve earlier choices')
  assert.equal(hired.length, 0, 'staging never creates a seat')
  await closeDraftSettings(panel())
  assert.equal(document.querySelector('.settings') === null, true)
  assert.equal(cancelled, 0, 'closing settings does not cancel the hire draft')
  await click(view.el.querySelector('.df-gear'))
  assert.equal(panel().querySelector<HTMLInputElement>('[aria-label="Disabled by Orgtree"]')!.checked, true)
  assert.equal(panel().querySelector<HTMLSelectElement>('[aria-label="Visible agents"]')!.value, 'self')
  await closeDraftSettings(panel())
  await click(view.el.querySelector('.df-foot button.primary'))
  assert.equal(hired.length, 1)
  assert.equal(hired[0]?.tools.orgtree_disabled, true)
  assert.equal(hired[0]?.org_visibility, 'self')
})
