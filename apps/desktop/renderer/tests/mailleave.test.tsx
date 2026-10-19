import './harness'
import { flush, inAct, JSDOM, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { MailList } from '../src/canvas/mail'
import { SurfaceDocumentOwner } from '../src/popout'
import type { MailListProps } from '../src/canvas/mail'

window.HTMLElement.prototype.scrollIntoView = () => {}
const rows = Array.from({length: 6}, (_, i) => ({id: `m${i}`, from: 'alpha', to: 'beta',
  at: `2026-10-19T10:00:0${i}Z`, body: `message ${i}`, tags: [i ? 'other' : 'chosen']}))
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')?.textContent ?? ''
const open = (id: string, el: HTMLElement) => {
  const row = [...el.querySelectorAll<HTMLElement>('.mailrow')].find(r => r.textContent?.includes(`message ${id.slice(1)}`))
  assert.ok(row); row.click()
}
const tick = async () => { await inAct(async () => { await flush(3) }) }

for (const route of ['text filter', 'tag filter', 'reference jump', 'rows removed', 'org change', 'sent folder'] as const) {
  test(`viewed mail is read once on ${route}`, async t => {
    const reads: string[] = []
    const props: MailListProps = {org: 'old', pending: rows, onRead: m => { reads.push(`old/${m.id}`) }}
    const view = await mountView(<MailList {...props}/>, el => el)
    t.after(() => view.unmount())
    await inAct(() => open('m0', view.el)); await tick()
    assert.match(pane(view.el), /message 0/)
    assert.deepEqual(reads, [], 'opening alone keeps the existing click-off rule')
    if (route === 'text filter') {
      await inAct(() => {
        const field = view.el.querySelector<HTMLInputElement>('.mail-filter')!
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, 'message 1')
        field.dispatchEvent(new Event('input', {bubbles: true}))
      })
    } else if (route === 'tag filter') {
      await view.render(<MailList {...props} tagFilter={{selected: ['other'], choices: [], onChange: () => {}}}/> )
    } else if (route === 'reference jump') {
      await view.render(<MailList {...props} jumpTo="m1" jumpSeq={1}/> )
    } else if (route === 'rows removed') {
      await view.render(<MailList {...props} pending={rows.slice(1)}/> )
    } else if (route === 'org change') {
      await view.render(<MailList {...props} org="new" onRead={m => { reads.push(`new/${m.id}`) }}/> )
    } else {
      await view.render(<MailList {...props} pending={[]} delivered={rows} outgoing/> )
    }
    await tick()
    assert.deepEqual(reads, ['old/m0'], 'previous committed mail and its original org callback are retained')
  })
}

for (const host of ['modal', 'desk tab', 'pin', 'project panel'] as const) {
  test(`unmounting ${host} marks only the opened mail`, async () => {
    const reads: string[] = []
    const view = await mountView(<MailList pending={rows} onRead={m => { reads.push(m.id!) }}/>, el => el)
    await inAct(() => open('m0', view.el))
    await view.render(<span/>); await tick()
    assert.deepEqual(reads, ['m0'])
    await view.unmount()
  })
}

for (const event of ['beforeunload', 'pagehide', 'orgtree:before-exit', 'orgtree:flush-mail-reads']) {
  test(`${event} flushes the opened mail without a React unmount`, async t => {
    const reads: string[] = []
    const waits: Promise<unknown>[] = []
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const view = await mountView(<MailList pending={rows} onRead={m => { reads.push(m.id!); return pending }}/>, el => el)
    t.after(() => view.unmount())
    await inAct(() => open('m0', view.el))
    await inAct(() => window.dispatchEvent(new window.CustomEvent(event, {detail: {waitUntil: (p: Promise<unknown>) => waits.push(p)}})))
    assert.deepEqual(reads, ['m0'])
    if (event.startsWith('orgtree:')) {
      assert.ok(waits.length > 0, 'native close receives pending read completion')
      let settled = false
      const drained = Promise.all(waits).then(() => { settled = true })
      await tick(); assert.equal(settled, false, 'close must wait for the actual save')
      finish(); await drained
    } else finish()
    await view.render(<span/>); assert.deepEqual(reads, ['m0'], 'subsequent cleanup never replays the read')
  })
}

test('pop-out close flushes its own document, not another open inbox', async t => {
  const child = new JSDOM('<!doctype html><body/>', {url: 'http://localhost/'})
  const reads: string[] = []
  const main = await mountView(<MailList pending={rows} onRead={m => { reads.push(`main/${m.id}`) }}/>, el => el)
  const pop = await mountView(<SurfaceDocumentOwner owner={child.window.document}>
    <MailList pending={rows} onRead={m => { reads.push(`child/${m.id}`) }}/>
  </SurfaceDocumentOwner>, el => el)
  t.after(async () => { await main.unmount(); await pop.unmount(); child.window.close() })
  await inAct(() => { open('m0', main.el); open('m1', pop.el) })
  await inAct(() => child.window.dispatchEvent(new child.window.Event('pagehide')))
  assert.deepEqual(reads, ['child/m1'])
})

test('a list refresh and scrolling leave the still-displayed mail unread', async t => {
  const reads: string[] = []
  const view = await mountView(<MailList pending={rows} onRead={m => { reads.push(m.id!) }}/>, el => el)
  t.after(() => view.unmount())
  await inAct(() => open('m0', view.el))
  await view.render(<MailList pending={rows.map(m => ({...m}))} onRead={m => { reads.push(m.id!) }}/>)
  await inAct(() => view.el.querySelector('.mailer-list')!.dispatchEvent(new Event('scroll', {bubbles: true})))
  assert.match(pane(view.el), /message 0/); assert.deepEqual(reads, [])
})

test('a second reference and then a keyboard move mark only the bodies left', async t => {
  const reads: string[] = []
  const props = {pending: rows, onRead: (m: {id?: string}) => { reads.push(m.id!) }}
  const view = await mountView(<MailList {...props} jumpTo="m0"/>, el => el)
  t.after(() => view.unmount())
  await view.render(<MailList {...props} jumpTo="m1" jumpSeq={2}/>); await tick()
  assert.deepEqual(reads, ['m0'])
  await inAct(() => view.el.querySelector('.mailer')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', altKey: true, bubbles: true})))
  assert.deepEqual(reads, ['m0', 'm1'])
})

test('all bodies in an opened folded notice are read, unopened notices are not', async () => {
  const reads: string[] = []
  const notices = rows.slice(0, 3).map(m => ({...m, from: '@system', kind: 'notice', tags: []}))
  const view = await mountView(<MailList pending={notices} jumpTo="m0" onRead={m => { reads.push(m.id!) }}/>, el => el)
  assert.equal(view.el.querySelectorAll('.notepile-row').length, 3, 'three full bodies are actually displayed')
  assert.deepEqual(reads, [])
  await view.unmount()
  assert.deepEqual(reads.sort(), ['m0', 'm1', 'm2'])
})

test('native flush also waits for a read already sent by a removed tab', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const view = await mountView(<MailList pending={rows} onRead={() => pending}/>, el => el)
  await inAct(() => open('m0', view.el))
  await view.render(<span/>)
  const waits: Promise<unknown>[] = []
  window.dispatchEvent(new window.CustomEvent('orgtree:flush-mail-reads', {detail: {waitUntil: (p: Promise<unknown>) => waits.push(p)}}))
  assert.ok(waits.length > 0)
  let done = false
  const drained = Promise.all(waits).then(() => { done = true })
  await tick(); assert.equal(done, false)
  finish(); await drained
  await view.unmount()
})

test('unopened lists, sent copies and question cards do not create mail reads', async () => {
  const reads: string[] = []
  for (const props of [{pending: rows}, {delivered: rows, outgoing: true},
    {pending: [{...rows[0]!, _ask: true}], jumpTo: 'm0'}]) {
    const view = await mountView(<MailList {...props} onRead={m => { reads.push(m.id!) }}/>, el => el)
    await view.unmount()
  }
  assert.deepEqual(reads, [])
})
