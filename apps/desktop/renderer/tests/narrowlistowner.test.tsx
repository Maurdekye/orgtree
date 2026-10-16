// A popout adopts the SAME list into another document. No window.resize is
// dispatched here: the owning document's content-box delivery must suffice.
import { inAct, JSDOM, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CollapsibleMailer } from '../src/canvas/narrowlist'
import { SurfaceDocumentOwner } from '../src/popout'

function observers(doc: Document) {
  const all: LocalObserver[] = []
  class LocalObserver {
    nodes = new Set<Element>()
    constructor(private notify: ResizeObserverCallback) { all.push(this) }
    observe(node: Element) { this.nodes.add(node) }
    unobserve(node: Element) { this.nodes.delete(node) }
    disconnect() { this.nodes.clear() }
  }
  const win = doc.defaultView! as Window & { ResizeObserver: typeof ResizeObserver }
  const old = win.ResizeObserver
  win.ResizeObserver = LocalObserver as unknown as typeof ResizeObserver
  return {
    constructor: win.ResizeObserver,
    fire: (node: Element) => {
      for (const ro of all) if (ro.nodes.has(node) && node.ownerDocument === doc)
        ro['notify']([] as ResizeObserverEntry[], ro as unknown as ResizeObserver)
    },
    active: () => all.reduce((n, ro) => n + ro.nodes.size, 0),
    restore: () => { win.ResizeObserver = old },
  }
}

for (const label of ['document list', 'message list']) {
  test(`${label}: adopted content follows its owner without window resize and keeps list state`, async () => {
    const popup = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
    const home = observers(document), away = observers(popup.window.document)
    const old = globalThis.ResizeObserver
    globalThis.ResizeObserver = home.constructor
    let width = 1000
    const viewFor = (owner: Document) => <SurfaceDocumentOwner owner={owner}>
      <CollapsibleMailer collapsible listLabel={label}
        list={<div className="mailer-list"><input defaultValue="kept filter" /></div>}>
        <div className="mailer-read">Selected item</div>
      </CollapsibleMailer>
    </SurfaceDocumentOwner>
    const v = await mountView(viewFor(document), el => el)
    const box = v.el.querySelector<HTMLElement>('.mailer')!
    const list = box.querySelector<HTMLElement>('.mailer-list')!
    const input = list.querySelector('input')!
    box.getBoundingClientRect = () => ({ width } as DOMRect)
    input.value = 'edited filter'; list.scrollTop = 123
    try {
      await inAct(() => home.fire(box))
      assert.equal(box.classList.contains('narrow-list'), false, 'wide home control')
      await inAct(() => { width = 896; home.fire(box) })
      assert.equal(box.classList.contains('narrow-list'), true, 'inclusive home breakpoint')
      await inAct(() => { width = 1000; home.fire(box) })
      assert.equal(box.classList.contains('narrow-list'), false, 'home widens')
      popup.window.document.body.appendChild(v.el)
      await v.render(viewFor(popup.window.document))
      for (const next of [896, 897, 600, 1000, 0, 895]) {
        await inAct(() => { width = next; away.fire(box) })
        const narrow = next > 0 && next <= 896
        assert.equal(box.classList.contains('narrow-list'), narrow, `popup own delivery at ${next}px`)
        assert.equal(box.querySelector('.mailer-listtoggle') !== null, narrow)
        assert.equal(box.querySelector('.mailer-list') === list, true, 'same list after adoption and resize')
        assert.equal(input.value, 'edited filter'); assert.equal(list.scrollTop, 123)
      }
      assert.equal(home.active(), 0, 'old observer disconnected after popout')
      document.body.appendChild(v.el)
      width = 1000
      await v.render(viewFor(document))
      assert.equal(away.active(), 0, 'popout observer disconnected after return')
      await inAct(() => { width = 896; home.fire(box) })
      assert.equal(box.classList.contains('narrow-list'), true, 'return follows original document again')
    } finally {
      await v.unmount()
      assert.equal(home.active() + away.active(), 0, 'unmount disconnects all observers')
      home.restore(); away.restore(); globalThis.ResizeObserver = old; popup.window.close()
    }
  })
}
