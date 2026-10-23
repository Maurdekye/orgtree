import { FakeServer, installFetch, flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { MailReplyBox } from '../src/canvas/mail'
import { captureSelectionComposer } from '../src/canvas/selectioncomposer'
import { captureObjectActions } from '../src/canvas/composerobjects'
import type { SelectionDraft, SelectionTarget } from '../src/replySelection'
import type { ReplyTarget } from '../src/generated/events'
import { CurrentOrg } from '../src/popout'

function deferred() {
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((_, fail) => { reject = fail })
  return { promise, reject }
}
function passage(id: number): SelectionDraft {
  const selector = { part: 'mail.body', projection: 'source-v1' as const, unit: 'unicode-scalar' as const,
    expected_sha256: 'a'.repeat(64), start: id, end: id + 1 }
  return { target: { kind: 'mail', org: 'fixture', id: `m${id}` }, selection: selector,
    snapshot: { version: 1, selector, revision: 1, excerpt: `passage-${id}`, prefix: '', suffix: '', state: 'exact' } }
}
function composer(target: string, onSend: Parameters<typeof MailReplyBox>[0]['onSend']) {
  return <CurrentOrg.Provider value="fixture"><div className="mailer-read"><p data-source>source</p>
    <MailReplyBox slug="fixture" target={target} objectActions onSend={onSend} />
  </div></CurrentOrg.Provider>
}
async function setup(t: TestContext, onSend: Parameters<typeof MailReplyBox>[0]['onSend']) {
  const prior = globalThis.fetch
  installFetch(new FakeServer())
  const fallback = globalThis.fetch
  globalThis.fetch = (async (input, init) => String(input).includes('/upload')
    ? new Response(JSON.stringify({ path: 'uploads/original.txt', bytes: 4 }), { status: 200 })
    : fallback(input, init)) as typeof fetch
  t.after(() => { globalThis.fetch = prior })
  const view = await mountView(composer('writer', onSend), el => el)
  t.after(() => view.unmount())
  const type = (text: string) => inAct(() => {
    const ta = view.el.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const stage = (id: number) => inAct(() => captureSelectionComposer(view.el.querySelector('[data-source]')!)!(passage(id)))
  const send = () => inAct(async () => { view.el.querySelector<HTMLButtonElement>('.mail-reply-send')!.click(); await flush(2) })
  const active = () => [...view.el.querySelectorAll('.selection-drafts .selection-excerpt')].map(el => el.textContent)
  const text = () => view.el.querySelector('textarea')!.value
  const saved = () => [...view.el.querySelectorAll('.mail-reply-recovery')]
  const restore = (index = 0) => saved()[index]!.querySelector<HTMLButtonElement>('.mail-reply-restore')!
  return { view, type, stage, send, active, text, saved, restore }
}

test('refusal of eight selections keeps the newer draft and the whole refused reply separately', async t => {
  const refused = deferred()
  const sent: { text: string; files?: string[]; object?: ReplyTarget; selections: SelectionTarget[] }[] = []
  const b = await setup(t, (text, files, _notice, _broadcast, object, selections) => {
    sent.push({ text, files, object, selections: selections ?? [] })
    return sent.length === 1 ? refused.promise : Promise.resolve()
  })
  for (let id = 0; id < 8; id++) await b.stage(id)
  await b.type('Original selected reply')
  await inAct(() => captureObjectActions(b.view.el.querySelector('[data-source]')!, '').reply!({
    kind: 'work_item', org: 'fixture', id: 'original-ticket', title: 'Original ticket',
  }))
  const input = b.view.el.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { value: [new File(['note'], 'original.txt')], configurable: true })
  await inAct(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await flush(10) })
  await b.send()
  assert.equal(sent[0]!.selections.length, 8)
  assert.deepEqual(sent[0]!.files, ['uploads/original.txt'])
  await b.type('Newer draft')
  await b.stage(8)
  await inAct(async () => { refused.reject(Error('Source changed')); await flush(5) })

  assert.deepEqual(b.active(), ['passage-8'], 'the newer passage remains staged')
  assert.equal(b.text(), 'Newer draft', 'the newer text is not combined with the refused text')
  assert.equal(b.saved().length, 1)
  assert.deepEqual([...b.saved()[0]!.querySelectorAll('.selection-excerpt')].map(el => el.textContent),
    Array.from({ length: 8 }, (_, id) => `passage-${id}`))
  assert.match(b.saved()[0]!.textContent!, /Original selected reply/)
  assert.match(b.saved()[0]!.textContent!, /original.txt/)
  assert.equal(b.restore().disabled, true, 'restoration cannot replace the new draft')

  await b.send()
  assert.equal(sent[1]!.text, 'Newer draft')
  assert.deepEqual(sent[1]!.selections, [{ target: passage(8).target, selection: passage(8).selection }])
  assert.equal(b.restore().disabled, false)
  await inAct(() => b.restore().click())
  assert.equal(b.text(), 'Original selected reply')
  assert.equal(b.active().length, 8)
  assert.equal(b.saved().length, 0)
  await b.send()
  assert.deepEqual(sent[2], sent[0], 'retry preserves every original selector, object and attachment')
})

test('several out-of-order refusals remain individually recoverable', async t => {
  const first = deferred(), second = deferred()
  const calls: { text: string; selections: SelectionTarget[] }[] = []
  const b = await setup(t, (text, _files, _notice, _broadcast, _object, selections) => {
    calls.push({ text, selections: selections ?? [] })
    return calls.length === 1 ? first.promise : calls.length === 2 ? second.promise : Promise.resolve()
  })
  await b.type('first'); await b.stage(0); await b.send()
  await b.type('second'); await b.stage(1); await b.send()
  await b.type('third'); await b.stage(2)
  await inAct(async () => { second.reject(Error('second refused')); await flush(2) })
  await inAct(async () => { first.reject(Error('first refused')); await flush(2) })
  assert.equal(b.text(), 'third'); assert.deepEqual(b.active(), ['passage-2'])
  assert.equal(b.saved().length, 2)
  await b.send()
  await inAct(() => b.restore().click()); await b.send()
  await inAct(() => b.restore().click()); await b.send()
  assert.deepEqual(calls.map(call => call.text), ['first', 'second', 'third', 'second', 'first'])
  assert.deepEqual(calls[3], calls[1]); assert.deepEqual(calls[4], calls[0])
  assert.equal(b.saved().length, 0)
})

test('a refusal stays with its original recipient while the current draft remains editable', async t => {
  const refused = deferred()
  const onSend = () => refused.promise
  const b = await setup(t, onSend)
  await b.type('original writer'); await b.stage(0); await b.send()
  await b.view.render(composer('other', onSend))
  await b.type('new recipient draft'); await b.stage(8)
  await inAct(async () => { refused.reject(Error('writer refused')); await flush(3) })
  assert.equal(b.text(), 'new recipient draft'); assert.deepEqual(b.active(), ['passage-8'])
  assert.equal(b.saved().length, 0, 'the other recipient does not show the refused reply')
  await b.view.render(composer('writer', onSend))
  assert.equal(b.text(), 'new recipient draft', 'returning does not overwrite current text')
  assert.equal(b.saved().length, 1)
  assert.equal(b.restore().disabled, true)
  await b.type('')
  await inAct(() => b.restore().click())
  assert.equal(b.text(), 'original writer'); assert.deepEqual(b.active(), ['passage-0'])
})

test('a selection-only newer draft blocks restoration even when its text is empty', async t => {
  const refused = deferred()
  const b = await setup(t, () => refused.promise)
  await b.type('original'); await b.stage(0); await b.send()
  await b.stage(8)
  await inAct(async () => { refused.reject(Error('refused')); await flush(3) })
  assert.equal(b.text(), ''); assert.deepEqual(b.active(), ['passage-8'])
  assert.equal(b.saved().length, 1); assert.equal(b.restore().disabled, true)
  assert.equal(b.view.el.querySelector('.mail-reply')!.getAttribute('data-panel-draft'), 'true')
})

test('a newer object staged before React paints is not replaced by an immediate refusal', async t => {
  const refused = deferred()
  const b = await setup(t, () => refused.promise)
  await b.type('original'); await b.stage(0); await b.send()
  await inAct(async () => {
    captureObjectActions(b.view.el.querySelector('[data-source]')!, '').reply!({
      kind: 'document', org: 'fixture', id: 'new-object', title: 'New object',
    })
    refused.reject(Error('refused before paint'))
    await flush(3)
  })
  assert.equal(b.text(), '')
  assert.equal(b.view.el.querySelector('[aria-label="Replying to presentation"]') !== null, true)
  assert.equal(b.saved().length, 1); assert.equal(b.restore().disabled, true)
})

test('newer text entered before React paints is not replaced by an immediate refusal', async t => {
  const refused = deferred()
  const b = await setup(t, () => refused.promise)
  await b.type('original'); await b.stage(0); await b.send()
  await inAct(async () => {
    const ta = b.view.el.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'newer text')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    refused.reject(Error('refused before paint'))
    await flush(3)
  })
  assert.equal(b.text(), 'newer text')
  assert.equal(b.saved().length, 1); assert.equal(b.restore().disabled, true)
})
