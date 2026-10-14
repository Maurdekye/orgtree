import { flush, inAct, mountView } from './harness'
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { TransferPanel } from '../src/canvas/transfers'
import { InboxView, OrgInboxModal } from '../src/canvas/mail'
import type { MailTransfer } from '../src/api'

const sample = (state = 'uploading'): MailTransfer => ({ id:'local-fixture', direction:'upload',
  peer:'@net:fixture', message_id:'mail-fixture', state, attempt:1,
  files:[{id:'file-fixture',name:'retained.txt',total:100,confirmed:40,processed:60}] })
const heading = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.mail-transfers .linkish')!

function transport(t: TestContext, rows = [sample()]) {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async input => {
    const url = String(input); requests.push(url)
    return new Response(JSON.stringify(url.includes('/transfers') ? {transfers:rows,next_cursor:null}
      : url.includes('/org_inbox') ? {entries:[],total:0,unread:0}
      : {pending:[],delivered:[],sent:[]}), {headers:{'X-Orgtree-Instance':'transfers-fixture'}})
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  return requests
}

for (const agent of [undefined, 'user', 'agent-fixture']) {
  test(`Transfers starts collapsed and preserves expansion across polling: ${agent ?? 'org inbox'}`, async t => {
    t.mock.timers.enable({apis:['setTimeout']})
    const rows = [sample()]; const requests = transport(t, rows)
    const v = await mountView(<TransferPanel slug="fixture" agent={agent}/>, el=>el)
    t.after(()=>v.unmount()); await flush()
    assert.equal(heading(v.el).getAttribute('aria-expanded'), 'false')
    assert.match(heading(v.el).textContent!, /Transfers.*1 unfinished/)
    assert.equal(v.el.querySelector('.transfer-list'), null)
    await inAct(()=>heading(v.el).click())
    assert.equal(heading(v.el).getAttribute('aria-expanded'), 'true')
    assert.equal(v.el.querySelectorAll('.transfer-card').length, 1)
    assert.equal(v.el.querySelector('progress')!.value, 40)
    rows[0].files![0].confirmed = 70
    await v.tick(1000, ms=>t.mock.timers.tick(ms)); await flush()
    assert.ok(requests.filter(url=>url.includes('/transfers')).length >= 2)
    assert.equal(heading(v.el).getAttribute('aria-expanded'), 'true')
    assert.equal(v.el.querySelector('progress')!.value, 70)
    await inAct(()=>heading(v.el).click())
    assert.equal(v.el.querySelector('.transfer-list'), null)
    assert.equal(requests.some(url=>url.includes('/local-fixture')), false, 'disclosure never changes a transfer')
  })
}

test('completed-only Transfers has no count and a reopened view starts collapsed', async t => {
  transport(t, [sample('complete')])
  const v = await mountView(<TransferPanel slug="fixture"/>,el=>el); t.after(()=>v.unmount()); await flush()
  assert.match(heading(v.el).textContent!, /Transfers$/)
  await inAct(()=>heading(v.el).click()); assert.equal(v.el.querySelector('progress')!.value,100)
  await v.render(null); await v.render(<TransferPanel slug="fixture"/>); await flush()
  assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
  assert.equal(v.el.querySelector('.transfer-card'),null)
})

test('a new mailbox scope starts collapsed even if its component is reused', async t => {
  transport(t)
  const v=await mountView(<TransferPanel slug="fixture" agent="first"/>,el=>el);t.after(()=>v.unmount());await flush()
  await inAct(()=>heading(v.el).click())
  await v.render(<TransferPanel slug="fixture" agent="second"/>);await flush()
  assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
  await inAct(()=>heading(v.el).click())
  await v.render(<TransferPanel slug="another-org" agent="second"/>);await flush()
  assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
})

test('org inbox and desk mailbox use the same collapsed one-click disclosure',async t=>{
  transport(t)
  const surfaces=[<OrgInboxModal slug="fixture" map={new Map()} close={()=>{}} toast={()=>{}}
    inbox={{entries:[],total:0,unread:0,visible:true,holders:[]}}/>,
    <InboxView slug="fixture" nid="agent-fixture"/>]
  for(const surface of surfaces){
    const v=await mountView(surface,el=>el);await flush()
    try{
      assert.equal(heading(v.el).getAttribute('aria-expanded'),'false')
      assert.equal(v.el.querySelector('.transfer-card'),null)
      await inAct(()=>heading(v.el).click())
      assert.equal(v.el.querySelectorAll('.transfer-card').length,1)
    }finally{await v.unmount()}
  }
})
