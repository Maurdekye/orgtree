import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentFilesView } from '../src/canvas/files'
import { bumpLive, flushLive, onLiveBump } from '../src/livebus'

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type':'application/json' } })
const file = (id: string, name: string) => ({ delivery_id:id,name,path:`C:/snapshot/${id}/${name}`,bytes:4096,note:'Original delivery snapshot',at:'2026-10-23T08:00:00Z' })
const liveBump = async () => inAct(async () => {
  await new Promise<void>(resolve => {
    const off = onLiveBump(() => {off();resolve()})
    bumpLive();flushLive()
  })
  await flush()
})

test('compact files open at the bottom, prepend older history and follow new files only at bottom', async () => {
  const calls: string[] = []
  let release!: (r: Response) => void
  let newest = [file('f3','release.zip'),file('f2','preview.png')]
  globalThis.fetch = (async url => {
    calls.push(String(url))
    if (calls.length === 1) return new Promise<Response>(r => { release = r })
    return response(String(url).includes('before=') ? {node:'maker',files:[file('f2','preview.png'),file('f1','old.log')],next_cursor:null}
      : {node:'maker',files:newest,next_cursor:'2'})
  }) as typeof fetch
  const view = await mountView(<AgentFilesView slug="fixture" nid="maker" />, el => el)
  const host = view.el.querySelector<HTMLDivElement>('.agent-files-scroll')!
  assert.ok(host)
  let top = 0
  Object.defineProperties(host, {
    scrollHeight: {get: () => host.querySelectorAll('li').length * 40},
    clientHeight: {get: () => 40},
    scrollTop: {get: () => top, set: value => { top = Math.max(0, Math.min(value, host.scrollHeight - 40)) }},
  })
  const rect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.tagName === 'LI' && this.parentElement?.className === 'agent-files-list') {
      const y = [...this.parentElement.children].indexOf(this) * 40 - host.scrollTop
      return {top:y,bottom:y+40,left:0,right:500,width:500,height:40,x:0,y,toJSON:()=>({})}
    }
    return rect.call(this)
  }
  const ids = () => [...host.querySelectorAll('li')].map(row => row.dataset.deliveryId)
  const scroll = async (value: number) => inAct(async () => {
    host.scrollTop = value;host.dispatchEvent(new window.Event('scroll'));await flush(2)
  })
  try {
    await inAct(async () => { release(response({node:'maker',files:newest,next_cursor:'2'}));await flush(2) })
    assert.equal(view.el.querySelectorAll('li').length,2)
    assert.deepEqual(ids(),['f2','f3'])
    assert.equal(host.scrollTop,40,'opening shows the newest file at the bottom')
    const link = view.el.querySelector<HTMLAnchorElement>('a[download="release.zip"]')!
    assert.ok(link);assert.match(link.href,/path=C%3A%2Fsnapshot%2Ff3%2Frelease.zip/)
    assert.equal(view.el.querySelector('time')?.dateTime,'2026-10-23T08:00:00Z')
    assert.match(view.el.querySelector('.agent-file-name')!.getAttribute('title')!,/Original delivery snapshot/)
    assert.equal(view.el.querySelectorAll('.filecard, img').length,0)
    assert.ok(view.el.querySelector('button[aria-label="View preview.png"]'))
    assert.doesNotMatch(view.el.textContent!,/Load older/)
    await scroll(0)
    assert.equal(view.el.querySelectorAll('li').length,3)
    assert.deepEqual(ids(),['f1','f2','f3'])
    assert.equal(host.scrollTop,40,'the previously visible row keeps its position after prepend')
    await scroll(0)
    newest = [file('f4','new.zip'),...newest]
    await liveBump()
    assert.deepEqual(ids(),['f1','f2','f3','f4'])
    assert.equal(host.scrollTop,0,'incoming files do not yank a scrolled-up view')
    await scroll(120)
    newest = [file('f5','newer.zip'),...newest]
    await liveBump()
    assert.deepEqual(ids(),['f1','f2','f3','f4','f5'])
    assert.equal(host.scrollTop,160,'a reader at the bottom follows new files')
    assert.ok(calls.some(url=>url.includes('before=2')))
    assert.ok(calls.every(url=>url.includes('/agents/maker/files?limit=50')))
  } finally { window.HTMLElement.prototype.getBoundingClientRect = rect;await view.unmount() }
})

test('a live bump during an older read queues catch-up across new page boundaries', async () => {
  let release!: (r: Response) => void
  let latest = 0
  const calls: string[] = []
  globalThis.fetch = (async url => {
    const path = String(url);calls.push(path)
    if (path.includes('before=9')) return new Promise<Response>(r => {release=r})
    if (path.includes('before=12')) return response({files:[file('11','11.zip'),file('10','10.zip')],next_cursor:'10'})
    return response(++latest === 1 ? {files:[file('10','10.zip'),file('9','9.zip')],next_cursor:'9'}
      : {files:[file('13','13.zip'),file('12','12.zip')],next_cursor:'12'})
  }) as typeof fetch
  const view = await mountView(<AgentFilesView slug="fixture" nid="maker" />, el => el)
  try {
    await inAct(async () => {await flush(2)})
    await inAct(async () => {view.el.querySelector('.agent-files-scroll')!.dispatchEvent(new window.Event('scroll'));await flush(2)})
    await liveBump()
    await inAct(async () => {release(response({files:[file('8','8.zip'),file('7','7.zip')],next_cursor:null}));await flush(4)})
    assert.deepEqual([...view.el.querySelectorAll('li')].map(row => row.dataset.deliveryId),['7','8','9','10','11','12','13'])
    assert.equal(calls.filter(path=>path.includes('before=9')).length,1)
    assert.ok(calls.some(path=>path.includes('before=12')),'new-page catch-up keeps the intervening file')
  } finally {await view.unmount()}
})

test('files reader ignores a prior agent response and exposes retryable errors', async () => {
  let release!: (r: Response) => void
  globalThis.fetch = (async url => String(url).includes('/first/') ? new Promise<Response>(r=>{release=r}) : response({node:'second',files:[],next_cursor:null})) as typeof fetch
  const view = await mountView(<AgentFilesView slug="fixture" nid="first" />,el=>el)
  try {
    await view.render(<AgentFilesView slug="fixture" nid="second" />)
    await inAct(async () => { release(response({files:[file('wrong','wrong.zip')],next_cursor:null}));await flush(2) })
    assert.match(view.el.textContent!,/No delivered files yet/)
    assert.doesNotMatch(view.el.textContent!,/wrong.zip/)
    globalThis.fetch = (async () => response({detail:'synthetic outage'})) as typeof fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({detail:'synthetic outage'}),{status:503})) as typeof fetch
    await inAct(async () => { view.el.querySelector('button')!.click();await flush(2) })
    assert.match(view.el.querySelector('[role="alert"]')!.textContent!,/synthetic outage/)
  } finally { await view.unmount() }
})
