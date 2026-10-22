// Explicit owned loopback fixture only. Actual save/picker/create components and
// fetch traffic, with canonical node transactions and post-commit effects off.
import { flush, inAct, mountView } from './harness'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SaveTemplateModal, liveNames } from '../src/canvas/templates'
import { CreateOrgView } from '../src/shell/createorg'
import type { TreeNode, TreePayload } from '../src/types'

const base = process.argv[2], rawOutput = process.argv[3].replaceAll('\\','/')
const output = rawOutput.startsWith('//?/') ? rawOutput.slice(4) : rawOutput
assert.equal(new URL(base).hostname, '127.0.0.1')
assert.ok(path.resolve(output).toLowerCase().startsWith('c:\\orgtree-build\\template-dogs-sol\\'))
const originalFetch = globalThis.fetch
type Receipt = { path: string; seconds: number; json_seconds: number; value: Record<string, any> }
const receipts: Receipt[] = []
const waiting = new Map<string, (r: Receipt) => void>()
const next = (method: string, pathname: string) => new Promise<Receipt>((resolve,reject) => {
  const key=method+' '+pathname
  const timer=setTimeout(()=>{waiting.delete(key);reject(new Error('fixture UI request did not finish: '+key))},pathname==='/api/orgs'?540_000:45_000)
  waiting.set(key,r=>{clearTimeout(timer);resolve(r)})
})
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input), base)
  assert.equal(url.origin, new URL(base).origin, 'fixture cannot contact any other origin')
  const clock = performance.now()
  const response = await originalFetch(url, init)
  const text = await response.text(), parseClock = performance.now()
  const value = JSON.parse(text), json_seconds = (performance.now() - parseClock) / 1000
  // Observe the same single JSON parse that req() consumes; do not serialize or
  // clone the nested tree, or parse a near-cap response twice.
  response.json = async () => value
  const receipt = { path: url.pathname, seconds: (performance.now() - clock) / 1000, json_seconds, value }
  receipts.push(receipt)
  const key = (init?.method ?? 'GET') + ' ' + url.pathname
  const done = waiting.get(key); waiting.delete(key); done?.(receipt)
  return response
}) as typeof fetch
const fixture = async (pathname: string, value?: unknown) => {
  const r = await originalFetch(new URL(pathname, base), value ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)} : undefined)
  assert.equal(r.status,200,await r.clone().text());return r.json()
}
const setName = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!
  setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))
}
const measurements = []
const previewOnly=process.env.ORGTREE_TEMPLATE_SCALE_PREVIEW_ONLY==='1'
for (const [nodes, depth, near_cap] of [[1000,20,false],[1000,1000,false],[5000,5000,false],[12000,12000,true]] as const) {
  console.log(`Starting desktop measurement nodes=${nodes} depth=${depth} near_cap=${near_cap}`)
  const seed = await fixture('/fixture/seed',{nodes,depth,near_cap})
  const source = await fixture('/fixture/result/' + seed.slug) as {name:string;parent:string|null;tier:string}[]
  const map = new Map(source.map(r => [r.name, {...r,id:r.name,state:'live',children:[]} as unknown as TreeNode]))
  const roots: TreeNode[] = []
  for (const r of source) { const node = map.get(r.name)!;if (r.parent) map.get(r.parent)!.children.push(node);else roots.push(node) }
  const tree = {roots} as TreePayload
  const clock = performance.now();assert.equal(liveNames(tree).size,nodes);const tree_seconds=(performance.now()-clock)/1000
  const orgName = `Depth ${nodes} ${depth} ${seed.slug.slice(-6)}`
  const saveStart = performance.now()
  const saveView = await mountView(<SaveTemplateModal slug={seed.slug} orgName={orgName} tree={tree} close={()=>{}}/>,e=>e)
  const dialog=document.querySelector<HTMLElement>('[aria-label="Save as template"]')!
  assert.ok(dialog)
  const saving = next('POST',`/api/orgs/${seed.slug}/template`)
  let saved: Receipt
  await inAct(async()=>{
    const button=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Save template')!
    assert.ok(button);button.click();saved=await saving;await flush(1)
  })
  assert.ok(!saved!.value.problems?.length,JSON.stringify(saved!.value.problems))
  assert.equal(saved!.value.agents, source.filter(r=>r.tier!=='project').length)
  assert.ok(dialog.textContent?.includes('Saved'))
  const bytes=Buffer.byteLength(saved!.value.content)
  assert.ok(bytes<=16*1024*1024)
  if(near_cap)assert.ok(bytes>16*1024*1024-2048)
  const save_seconds=(performance.now()-saveStart)/1000
  console.log(`Desktop save completed nodes=${nodes} bytes=${bytes} seconds=${save_seconds}`)
  await saveView.unmount()
  let complete!: (slug:string)=>void
  const created=new Promise<string>(resolve=>{complete=resolve})
  const listing=next('GET','/api/templates')
  const createView=await mountView(<CreateOrgView onCreated={slug=>{complete(slug)}} onRequestClose={()=>{}}/>,e=>e)
  await inAct(async()=>{await listing;await flush(1)})
  const relisting=next('GET','/api/templates')
  await inAct(async()=>{setName(createView.el.querySelector<HTMLInputElement>('#shell-create-name')!,`Created ${nodes} ${depth} ${seed.slug.slice(-6)}`);await flush(1)})
  await inAct(async()=>{await relisting;await flush(1)})
  const previewing=next('POST','/api/templates/resolve'), previewStart=performance.now()
  let preview: Receipt
  await inAct(async()=>{
    const option=[...createView.el.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b=>b.textContent?.includes(orgName+' layout'))!
    assert.ok(option,'saved template appears in the real listing');option.click();await flush(1)
  })
  await inAct(async()=>{preview=await previewing;await flush(1)})
  assert.equal(preview!.value.agents.length,nodes)
  assert.equal(Math.max(...preview!.value.agents.map((r:{depth:number})=>r.depth)),depth-1)
  assert.equal(preview!.value.ok,true,JSON.stringify(preview!.value.blocked))
  assert.ok(createView.el.querySelectorAll('tbody tr').length<=100,'DOM rows stay bounded')
  assert.equal(createView.el.querySelectorAll('tbody tr').length,100)
  const preview_seconds=(performance.now()-previewStart)/1000
  console.log(`Desktop preview completed nodes=${nodes} seconds=${preview_seconds}; canonical creation ${previewOnly?'deferred':'starting'}`)
  if(previewOnly){
    const measured={nodes,depth,bytes,tree_seconds,save_seconds,save_http_seconds:saved!.seconds,save_json_seconds:saved!.json_seconds,preview_seconds,preview_http_seconds:preview!.seconds,canonical_create:'deferred to integrated shared-credit fix',source_nodes:source.length}
    measurements.push(measured);console.log('DESKTOP_TEMPLATE_SCALE '+JSON.stringify(measured))
    fs.writeFileSync(path.join(output,'preview-measurements.json'),JSON.stringify(measurements,null,2))
    await createView.unmount();continue
  }
  const creating=next('POST','/api/orgs'), createStart=performance.now()
  let made: Receipt,slug:string
  await inAct(async()=>{
    const button=createView.el.querySelector<HTMLButtonElement>('button[type="submit"]')!
    assert.ok(button && !button.disabled,'preview enables Create');button.click();made=await creating;slug=await created;await flush(1)
  })
  const create_seconds=(performance.now()-createStart)/1000
  const rows=await fixture('/fixture/result/'+slug!) as {name:string;parent:string|null;tier:string;scope:Record<string,any>}[]
  assert.equal(rows.length,nodes)
  const depths=new Map<string,number>()
  for(const r of rows){assert.ok(!r.parent||depths.has(r.parent));depths.set(r.name,r.parent?depths.get(r.parent)!+1:0)}
  assert.equal(Math.max(...depths.values()),depth-1)
  for(const r of rows.filter(r=>r.tier!=='project'))assert.equal(r.scope.tools.bash,false,'outer scope remains binding')
  const measured={nodes,depth,bytes,tree_seconds,save_seconds,save_http_seconds:saved!.seconds,save_json_seconds:saved!.json_seconds,preview_seconds,preview_http_seconds:preview!.seconds,create_seconds,canonical_create_seconds:made!.value.measurement.create_seconds,effects_applied:made!.value.measurement.effects_applied,result_nodes:rows.length,result_depth:Math.max(...depths.values())+1}
  measurements.push(measured);console.log('DESKTOP_TEMPLATE_SCALE '+JSON.stringify(measured))
  fs.writeFileSync(path.join(output,'measurements.json'),JSON.stringify(measurements,null,2))
  await createView.unmount()
}
console.log(previewOnly?'PASS desktop save, validation and preview; canonical create explicitly deferred to integrated tip':'PASS desktop save, validation, preview, canonical create and flat result at every measured size')
process.exit(0)
