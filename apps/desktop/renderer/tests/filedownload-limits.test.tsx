import {flush,JSDOM} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as mod from '../src/canvas/filedownload'

// A delivered file is saved by Electron's native download straight to disk (main/remote-downloads.ts):
// no 256 MiB cap, and no fetch + Blob of the whole file in the page.
test('no in-page download cap or Blob reader is left',()=>{
  assert.equal('FILE_DOWNLOAD_MAX' in mod,false)
  assert.equal('readDownloadBlob' in mod,false)
})

for(const length of ['1024',String(300*1024*1024),String(33*1024*1024*1024)])test(`a ${length}-byte file starts a native download, not a refusal or a buffer`,async()=>{
  const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'}),owner=dom.window.document
  const fetchBefore=globalThis.fetch,createBefore=window.URL.createObjectURL
  const create=owner.createElement.bind(owner),clicks:{href:string;name:string}[]=[],calls:{url:string;method?:string}[]=[]
  let blobs=0
  globalThis.fetch=(async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push({url:String(url),method:init?.method});return new Response(null,{headers:{'Content-Length':length,'Content-Disposition':'inline; filename="big.bin"'}})}) as typeof fetch
  window.URL.createObjectURL=(()=>{blobs++;return 'blob:x'}) as typeof window.URL.createObjectURL
  owner.createElement=((tag:string,...args:unknown[])=>{const e=create(tag,...args as []);if(tag==='a')(e as HTMLAnchorElement).click=()=>clicks.push({href:(e as HTMLAnchorElement).getAttribute('href')!,name:(e as HTMLAnchorElement).download});return e}) as typeof owner.createElement
  try{
    await mod.downloadFile(owner,'/api/orgs/o/nodes/n/file?path=big.bin','big.bin')
    assert.equal(blobs,0,'no Blob of the file is made')
    assert.ok(calls.every(c=>c.method==='HEAD'),'the file body is never fetched into the page')
    assert.deepEqual(clicks,[{href:'/api/orgs/o/nodes/n/file?path=big.bin',name:'big.bin'}],'a native download anchor on the engine route')
  }finally{owner.createElement=create;globalThis.fetch=fetchBefore;window.URL.createObjectURL=createBefore;dom.window.close()}
})

test('an engine refusal shows in the card and starts nothing',async()=>{
  const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'}),owner=dom.window.document
  const fetchBefore=globalThis.fetch,create=owner.createElement.bind(owner);let clicks=0
  globalThis.fetch=(async()=>new Response('no',{status:403})) as typeof fetch
  owner.createElement=((tag:string,...a:unknown[])=>{const e=create(tag,...a as []);if(tag==='a')(e as HTMLAnchorElement).click=()=>{clicks++};return e}) as typeof owner.createElement
  try{
    await assert.rejects(mod.downloadFile(owner,'/api/orgs/o/nodes/n/file?path=x','x'),/403/)
    assert.equal(clicks,0)
  }finally{owner.createElement=create;globalThis.fetch=fetchBefore;dom.window.close()}
})
