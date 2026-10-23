import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentFilesView } from '../src/canvas/files'
import { bumpLive, flushLive } from '../src/livebus'

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type':'application/json' } })
const file = (id: string, name: string) => ({ delivery_id:id,name,path:`C:/snapshot/${id}/${name}`,bytes:4096,note:'Original delivery snapshot',at:'2026-10-23T08:00:00Z' })

test('files list keeps delivery snapshots and older pages independently of transcript', async () => {
  const calls: string[] = []
  globalThis.fetch = (async url => {
    calls.push(String(url))
    return response(String(url).includes('before=') ? {node:'maker',files:[file('f1','old.log')],next_cursor:null}
      : {node:'maker',files:[file('f3','release.zip'),file('f2','preview.png')],next_cursor:'2'})
  }) as typeof fetch
  const view = await mountView(<AgentFilesView slug="fixture" nid="maker" />, el => el)
  try {
    await inAct(async () => { await flush(2) })
    assert.equal(view.el.querySelectorAll('li').length,2)
    const link = view.el.querySelector<HTMLAnchorElement>('a[download="release.zip"]')!
    assert.ok(link);assert.match(link.href,/path=C%3A%2Fsnapshot%2Ff3%2Frelease.zip/)
    assert.equal(view.el.querySelector('time')?.dateTime,'2026-10-23T08:00:00Z')
    assert.match(view.el.textContent!,/Original delivery snapshot/)
    assert.match(view.el.querySelector('img')!.src,/preview.png/)
    await inAct(async () => { [...view.el.querySelectorAll('button')].find(b=>b.textContent==='Load older files')!.click();await flush(2) })
    assert.equal(view.el.querySelectorAll('li').length,3)
    await inAct(async () => { bumpLive();flushLive();await flush(2) })
    assert.equal(view.el.querySelectorAll('li').length,3,'live traffic must not reset older-file browsing')
    assert.ok(calls.some(url=>url.includes('before=2')))
    assert.ok(calls.every(url=>url.includes('/agents/maker/files?limit=50')))
  } finally { await view.unmount() }
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
