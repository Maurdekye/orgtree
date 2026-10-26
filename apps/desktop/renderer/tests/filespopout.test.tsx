import { flush, inAct, JSDOM, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPortal } from 'react-dom'
import { AgentFilesView } from '../src/canvas/files'
import { closeLightbox, openLightbox } from '../src/canvas/lightbox'

test('Escape closes only the owning lightbox before a detached surface stops keyboard bubbling', () => {
  const other = new JSDOM('<html><body><div><button>View</button></div></body></html>', { url:'http://localhost/' })
  const doc = other.window.document, boundary = doc.querySelector('div')!, button = doc.querySelector('button')!
  let lowerEscapes = 0
  boundary.addEventListener('keydown', e => { ++lowerEscapes; e.stopPropagation() })
  try {
    openLightbox('data:image/png;base64,AA==', {}, document)
    openLightbox('data:image/png;base64,AA==', {}, doc)
    button.focus()
    const event = new other.window.KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true})
    button.dispatchEvent(event)
    assert.equal(doc.querySelector('.lb-overlay'),null,'the portal viewer closes despite its keyboard boundary')
    assert.ok(event.defaultPrevented,'Escape is consumed by the viewer')
    assert.equal(lowerEscapes,0,'the lower desk does not also handle Escape')
    assert.ok(document.querySelector('.lb-overlay'),'another document keeps its own viewer')
    button.dispatchEvent(new other.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}))
    assert.equal(lowerEscapes,1,'closing removed the capture listener')
    openLightbox('data:image/png;base64,AA==',{},doc)
    ;(doc.querySelector('.lb-x') as HTMLButtonElement).click()
    assert.equal(doc.querySelector('.lb-overlay'),null,'explicit close remains a positive control')
  } finally {closeLightbox(doc);closeLightbox(document);other.window.close()}
})

for (const selector of ['.agent-file-name','.agent-file-download']) test(`Files ${selector} fetches in the main realm and saves a Blob in the owning document`, async () => {
  const other = new JSDOM('<html><body><div id="files"></div></body></html>',{url:'http://localhost/'})
  const owner = other.window.document, calls:string[] = [], saved:{url:string;name:string;owner:Document}[] = []
  const originalFetch = globalThis.fetch, originalCreate = window.URL.createObjectURL, originalRevoke = window.URL.revokeObjectURL
  const originalTimeout = window.setTimeout, create = owner.createElement.bind(owner)
  let blob:Blob|undefined
  globalThis.fetch = (async url => {
    calls.push(String(url))
    return String(url).includes('/files') ? new Response(JSON.stringify({node:'maker',next_cursor:null,files:[{
      delivery_id:'one',name:'example.txt',path:'C:/snapshot/example.txt',bytes:13,at:'2026-10-25T00:00:00Z',note:null,
    }]}),{headers:{'Content-Type':'application/json'}}) : new Response('RC POINTER P\n',{headers:{'Content-Type':'text/plain'}})
  }) as typeof fetch
  other.window.fetch = (() => {throw Error('portal fetch must not sign API requests')}) as typeof fetch
  window.URL.createObjectURL = value => {blob=value as Blob;return 'blob:http://localhost/owned-file'}
  window.URL.revokeObjectURL = () => {}
  window.setTimeout = ((fn:()=>void) => {fn();return 0}) as typeof window.setTimeout
  const view = await mountView(<>{createPortal(<AgentFilesView slug="fixture" nid="maker" />,owner.getElementById('files')!)}</>,el=>el)
  try {
    await inAct(async()=>{await flush(3)})
    owner.createElement = ((tag:string,...args:unknown[]) => {
      const element = create(tag,...args as [])
      if(tag==='a') (element as HTMLAnchorElement).click=()=>saved.push({url:(element as HTMLAnchorElement).href,name:(element as HTMLAnchorElement).download,owner:element.ownerDocument})
      return element
    }) as typeof owner.createElement
    await inAct(async()=>{(owner.querySelector(selector) as HTMLAnchorElement).click();await flush(4)})
    assert.equal(calls.filter(url=>url.includes('/file?')).length,1,'a native HTTP download is replaced with authenticated main-realm fetch')
    assert.deepEqual(saved.map(s=>({url:s.url,name:s.name})),[{url:'blob:http://localhost/owned-file',name:'example.txt'}])
    assert.equal(saved[0].owner,owner)
    assert.equal(await blob!.text(),'RC POINTER P\n','exact downloaded bytes survive the bridge')
  } finally {
    owner.createElement=create;await view.unmount();globalThis.fetch=originalFetch
    window.URL.createObjectURL=originalCreate;window.URL.revokeObjectURL=originalRevoke;window.setTimeout=originalTimeout
    other.window.close()
  }
})
