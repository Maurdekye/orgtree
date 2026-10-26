import {flush,JSDOM} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {openLightbox,closeLightbox} from '../src/canvas/lightbox'

for(const fail of [false,true])test(`lightbox download uses the owning document and ${fail?'shows HTTP failure':'saves authenticated bytes without closing the viewer'}`,async()=>{
  const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'}),owner=dom.window.document
  const fetchBefore=globalThis.fetch,createBefore=window.URL.createObjectURL,revokeBefore=window.URL.revokeObjectURL,timeoutBefore=window.setTimeout
  const create=owner.createElement.bind(owner),saved:{owner:Document;href:string;name:string}[]=[],calls:string[]=[]
  let payload:Blob|undefined,capture=false
  globalThis.fetch=(async url=>{calls.push(String(url));return fail?new Response('forbidden',{status:403}):new Response('RC POINTER P\n')}) as typeof fetch
  dom.window.fetch=(()=>{throw Error('do not fetch from the portal realm')}) as typeof fetch
  window.URL.createObjectURL=value=>{payload=value as Blob;return 'blob:http://localhost/lightbox'}
  window.URL.revokeObjectURL=()=>{}
  window.setTimeout=((fn:()=>void)=>{fn();return 0}) as typeof window.setTimeout
  owner.createElement=((tag:string,...args:unknown[])=>{const e=create(tag,...args as []);if(tag==='a'&&capture)(e as HTMLAnchorElement).click=()=>saved.push({owner:e.ownerDocument,href:(e as HTMLAnchorElement).href,name:(e as HTMLAnchorElement).download});return e}) as typeof owner.createElement
  try{
    openLightbox('data:image/png;base64,AA==',{name:'example.png',download:'/api/orgs/fixture/nodes/maker/file?path=example.png'},owner)
    capture=true;(owner.querySelector('.lb-dl') as HTMLAnchorElement).click();await flush(4)
    assert.equal(calls.length,1,'the raw viewer anchor must use the authenticated main-realm helper')
    assert.ok(owner.querySelector('.lb-overlay'),'downloading does not dismiss the viewer')
    if(fail){assert.equal(saved.length,0);assert.match(owner.querySelector('[role="alert"]')?.textContent??'',/403/)}
    else{assert.equal(saved.length,1);assert.equal(saved[0].owner,owner);assert.equal(saved[0].name,'example.png');assert.equal(saved[0].href,'blob:http://localhost/lightbox');assert.equal(await payload!.text(),'RC POINTER P\n')}
  }finally{
    closeLightbox(owner);owner.createElement=create;globalThis.fetch=fetchBefore;window.URL.createObjectURL=createBefore;window.URL.revokeObjectURL=revokeBefore;window.setTimeout=timeoutBefore;dom.window.close()
  }
})
