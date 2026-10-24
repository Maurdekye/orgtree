import { advance, FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { installAppShortcuts, type CanvasShortcutRef } from '../src/shell/appshortcuts'
import { resetConvos } from '../src/convo'
import { lastDeskTree } from './lastdesk.fixture'

test('six consecutive org arrows survive new agent and project composer autofocus without mouse or refocus', async t => {
  useFakeClock(); installFetch(new FakeServer()); localStorage.clear()
  const shortcuts: CanvasShortcutRef = { current: null }, tree = lastDeskTree('six-keyboard-moves')
  const render = (focusAgent?: string) => <OrgCanvas tree={tree} slug={tree.slug}
    op={async () => ({})} toast={() => {}} mailEvt={null} canvasShortcuts={shortcuts} focusAgent={focusAgent} />
  const view = await mountView(render(), el => el)
  const stop = installAppShortcuts(window, () => shortcuts.current ?? {})
  t.after(async () => { stop(); await view.unmount(); resetConvos(); realClock() })
  await flush(); await advance(2600); await view.render(render('project')); await advance(1200)
  await inAct(() => view.el.querySelector<HTMLButtonElement>('.project-desk button')!.focus())
  for (const expected of ['bravo', 'alpha', 'project', 'bravo', 'alpha', 'project']) {
    const event = new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true,
      altKey: true, bubbles: true, cancelable: true })
    await inAct(() => document.activeElement!.dispatchEvent(event))
    assert.equal(event.defaultPrevented, true, 'consecutive navigation stays admitted')
    await advance(1200)
    const desks = [...view.el.querySelectorAll('.sq.desk:not(.user)')]
      .map(el => el.getAttribute('data-first-use-agent') ?? el.getAttribute('data-copy-agent-name'))
    assert.deepEqual(desks, [expected])
    assert.equal(document.activeElement?.tagName, 'TEXTAREA', 'new desk preserves composer autofocus')
  }
})
