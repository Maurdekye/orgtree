import { flush, inAct, mountView } from './harness'
import { createPortal } from 'react-dom'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CurrentOrg } from '../src/popout'
import { MailReplyBox } from '../src/canvas/mail'
import { ReplySelectionSurface } from '../src/canvas/replyselection'

// Model the viewport boxes, not jsdom's layout (which is always zero). The
// transparent source stays zero-sized in every placement, as in Chromium.
for (const placement of ['canvas', 'floating', 'pinned', 'popout'] as const) {
  test(`selection menu uses the pressed text's viewport coordinates: ${placement}`, async t => {
    const frame = placement === 'popout' ? document.createElement('iframe') : null
    if (frame) document.body.append(frame)
    const doc = frame?.contentDocument ?? document
    const win = doc.defaultView!
    const content = <CurrentOrg.Provider value="demo"><div className="mailer-read" style={placement === 'canvas' ? { transform: 'translate(80px,40px) scale(.7)' } : undefined}>
      <ReplySelectionSurface source={{ org: 'demo', target: { kind: 'mail', org: 'demo', id: 'm1' }, part: { part: 'mail.body' }, text: 'one passage two' }}>
        <p tabIndex={0}>one <strong>passage</strong> two</p>
      </ReplySelectionSurface>
      <MailReplyBox slug="demo" target="writer" objectActions onSend={() => {}} />
    </div></CurrentOrg.Provider>
    const view = await mountView(frame ? createPortal(content, doc.body) : content, el => el)
    t.after(async () => { await view.unmount(); frame?.remove() })
    const source = doc.querySelector<HTMLElement>('.selection-source')!
    const text = source.querySelector<HTMLElement>('strong')!
    assert.equal(source.style.display, 'contents')
    const box = { x: 420, y: 180, left: 420, top: 180, right: 700, bottom: 230, width: 280, height: 50, toJSON() {} }
    text.getBoundingClientRect = () => box
    const selected = doc.getSelection()!, range = doc.createRange()
    range.selectNodeContents(text); selected.removeAllRanges(); selected.addRange(range)
    t.after(() => selected.removeAllRanges())
    const open = async (x: number, y: number) => {
      const event = new (win as unknown as typeof window).MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y })
      await inAct(async () => { text.dispatchEvent(event); await flush(2) })
      assert.equal(event.defaultPrevented, true)
      const menu = doc.querySelector<HTMLElement>('.ctxmenu')!
      assert.ok(menu)
      assert.equal(menu.parentElement, doc.body, 'portal stays in the originating document')
      assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map(el => el.textContent), ['Reply to selection', 'Copy selection'])
      return { x: parseFloat(menu.style.left), y: parseFloat(menu.style.top) }
    }
    assert.deepEqual(await open(460, 210), { x: 460, y: 210 }, 'pointer must not fall back to the zero-size source wrapper')
    assert.deepEqual(await open(0, 0), { x: box.left, y: box.bottom }, 'keyboard invocation falls back to the pressed text box')
    text.getBoundingClientRect = () => ({ ...box, right: win.innerWidth, bottom: win.innerHeight, width: win.innerWidth - box.left, height: win.innerHeight - box.top })
    assert.deepEqual(await open(win.innerWidth - 1, win.innerHeight - 1), { x: win.innerWidth - 4, y: win.innerHeight - 4 }, 'existing viewport-edge clamp still applies')
    if (frame) assert.equal(document.querySelector('.ctxmenu'), null, 'popout must not open the menu in the main document')
  })
}
