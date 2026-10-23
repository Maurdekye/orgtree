import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import { orgDndTree, orgDndResponse } from './orgdnd-fixture'

test('Org DnD Connections exposes three modes, Hubchat warning, and saves the selected mode', async () => {
  const writes: Record<string, unknown>[] = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/settings') && init?.body) writes.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify(orgDndResponse(String(url))), { status: 200 })
  }
  const view = await mountView(<SettingsPanel tree={orgDndTree} initialTab="mailserver" toast={() => {}} close={() => {}} />)
  try {
    await inAct(async () => { await flush(8) })
    const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="org inbox mode"]')
    assert.equal(!!select, true, 'Connections must contain the org inbox dropdown')
    assert.deepEqual([...select!.options].map(o => o.text), ['Normal operations', 'Do not disturb', 'Closed off inbox'])
    assert.equal(select!.value, 'dnd')
    assert.equal(view.el.querySelector('#org-inbox-dnd-warning')?.textContent?.includes('Hubchat'), true)
    assert.equal(view.el.querySelector('#org-inbox-dnd-warning')?.textContent?.includes('not read or delivered automatically'), true)
    const change = async (value: string) => inAct(async () => {
      const w = select!.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
      select!.dispatchEvent(new w.Event('change', { bubbles: true })); await flush()
    })
    await change('closed')
    assert.equal(!!view.el.querySelector('#org-inbox-dnd-warning'), false)
    await change('normal')
    assert.equal(!!view.el.querySelector('#org-inbox-dnd-warning'), false)
    await change('dnd')
    const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim().toLowerCase() === 'save')
    assert.equal(!!save, true)
    await inAct(async () => { save!.click(); await flush(10) })
    assert.equal(writes.at(-1)?.org_inbox_mode, 'dnd')
    assert.equal('org_inbox_enabled' in (writes.at(-1) ?? {}), false)
  } finally { await view.unmount() }
})
