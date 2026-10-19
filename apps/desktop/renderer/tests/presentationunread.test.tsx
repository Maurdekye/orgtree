import { mountView, flush, inAct, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import { markDocViewed } from '../src/canvas/docviewed'

const at = '2026-10-19T12:00:00Z'
const earlier = '2026-10-18T12:00:00Z'

for (const surface of ['modal', 'agent', 'project'] as const) {
  test(`${surface}: presentation lists highlight new and updated, clear on open and sync existing viewed marks`, async t => {
    useFakeClock()
    const slug = `presentation-unread-${surface}`
    const node = surface === 'project' ? 'test-project' : 'test-agent'
    const rows = [
      { id:'read', title:'Already read', viewed_at:at },
      { id:'new', title:'Never opened', viewed_at:null },
      { id:'updated', title:'Changed since opened', viewed_at:earlier, format:'html' },
      { id:'elsewhere', title:'Opened in another surface', viewed_at:null },
    ].map(r => ({node, at, evicted:false, node_state:'live', tier:'sol', format:'markdown', ...r}))
    const posted: string[] = []
    globalThis.fetch = (async (url, options) => {
      const path = String(url)
      if (path.endsWith('/documents/viewed')) {
        posted.push(...JSON.parse(String(options?.body)).marks.map((m: {id:string}) => m.id))
        return {ok:true, json:async()=>({ok:true})} as Response
      }
      const id = path.match(/\/documents\/([^/?]+)$/)?.[1]
      return {ok:true, json:async()=>id ? {...rows.find(r=>r.id===id),body:'# Synthetic document'}
        : {documents:rows,total:rows.length,next_offset:null}} as Response
    }) as typeof fetch
    const props = {slug,toast:()=>{}}
    const v = await mountView(surface === 'modal' ? <DocGalleryModal {...props} close={()=>{}} />
      : <AgentGalleryView {...props} nid={node} node={{id:node,kind:surface==='project'?'project':'agent'} as any} />, host=>host)
    t.after(async()=>{await v.unmount();realClock()})
    await flush()
    const list = () => [...v.el.querySelectorAll<HTMLElement>('.doc-gallery-row')]
    const row = (title:string) => list().find(r=>r.querySelector('.mfrom')?.textContent===title)!
    assert.equal(list().length,4,'real list loaded')
    assert.equal(row('Already read').classList.contains('unread'),false,'engine viewed_at wins without a local mark')
    assert.equal(row('Never opened').classList.contains('unread'),true,'new presentation wears unread mail styling')
    assert.equal(row('Never opened').dataset.docUnread,'new')
    assert.equal(row('Changed since opened').classList.contains('unread'),true,'replacement wears unread mail styling')
    assert.equal(row('Changed since opened').dataset.docUnread,'updated')
    await inAct(()=>row('Never opened').click());await flush()
    assert.equal(row('Never opened').classList.contains('unread'),false,'opening clears highlight')
    assert.equal(row('Changed since opened').classList.contains('unread'),true,'opening one leaves another unread')
    await inAct(()=>row('Changed since opened').click());await flush()
    assert.equal(row('Changed since opened').classList.contains('unread'),false,'opening HTML clears updated highlight')
    await inAct(()=>markDocViewed(slug,'elsewhere',at))
    assert.equal(row('Opened in another surface').classList.contains('unread'),false,'shared viewed store clears other mounted lists')
    assert.equal(posted.includes('new'),true,'existing durable viewed endpoint used')
    assert.equal(posted.includes('updated'),true)
  })
}
