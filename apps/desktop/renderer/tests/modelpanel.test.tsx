import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ToggleChips } from '../src/canvas/modelbrowser'

test('model panel browse action and + open the same menu; chip action stays independent', async () => {
  let opened = 0, toggled = 0
  const view = await mountView(<ToggleChips label="Fixture models" busy={false}
    chips={[{key:'fixture', letter:'F', color:'#aa8800', label:'Fixture model',
      title:'toggle Fixture model', on:true, onToggle:()=>{ toggled++ }}]}
    more={{title:'Browse the catalog', onClick:()=>{ opened++ }}} />, el=>el)
  try {
    const panel = view.el.querySelector('button[aria-label="Browse Fixture models"]')!
    assert.ok(panel, 'empty panel space has a native keyboard browse action')
    assert.equal(panel.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(panel.getAttribute('aria-expanded'), 'false')
    await inAct(()=>{ (panel as HTMLButtonElement).focus(); (panel as HTMLButtonElement).click() })
    assert.equal(document.activeElement, panel)
    assert.equal(opened, 1)
    await inAct(()=>{ (view.el.querySelector('.orr-tog') as HTMLButtonElement).click() })
    assert.equal(toggled, 1)
    assert.equal(opened, 1, 'clicking a chip does not also browse')
    await inAct(()=>{ (view.el.querySelector('.orr-more') as HTMLButtonElement).click() })
    assert.equal(opened, 2)
  } finally { await view.unmount() }
})

test('an empty model panel exposes browse; an open browser is announced', async () => {
  let opened=0
  const view=await mountView(<ToggleChips label="Empty models" busy={true} chips={[]}
    hint="No model offered yet" more={{title:'Browse',open:true,onClick:()=>{ opened++ }}} />,el=>el)
  try {
    const button=view.el.querySelector('button[aria-label="Browse Empty models"]') as HTMLButtonElement
    assert.ok(button)
    assert.equal(button.getAttribute('aria-expanded'),'true')
    await inAct(()=>button.click())
    assert.equal(opened,1, 'browsing remains available while mutation is busy, like +')
  } finally { await view.unmount() }
})

test('without a browser callback the chip group gains no extra action', async () => {
  const view=await mountView(<ToggleChips label="Read-only models" busy={false} chips={[]} />,el=>el)
  try { assert.equal(view.el.querySelector('.orr-panel-open'),null) }
  finally { await view.unmount() }
})
