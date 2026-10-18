import './harness'
import { flush, inAct, mountView } from './harness'
import { createPortal } from 'react-dom'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ShellHeader } from '../src/shell/header'

declare const __SRC_DIR__: string
const response = (data: string | null, status = 200) => new Response(JSON.stringify({owner:1,picture:{revision:'test',data}}),{status,headers:{'Content-Type':'application/json'}})
const settle = () => inAct(() => flush())
const title = (slug = 'one', revision: string | null = 'r1', quick = false) =>
  <ShellHeader menu={<button>Menu</button>} title={slug} orgSlug={slug} logoRevision={revision}
    quick={quick ? <input aria-label="Quick chat" /> : undefined} />
const logo = (el: ParentNode) => el.querySelector<HTMLImageElement>('img.org-header-logo')
function fetchFor(t: {after(fn: () => void): void}, fetcher: typeof fetch) {
  const old=globalThis.fetch;globalThis.fetch=fetcher;t.after(()=>{globalThis.fetch=old})
}

test('flat org header places its square logo immediately before the name',async t=>{
  fetchFor(t,async()=>response('AQ=='))
  const v=await mountView(title(),el=>el);t.after(()=>v.unmount());await settle()
  const img=logo(v.el),heading=v.el.querySelector('.shell-header-title')!
  assert.equal(img?.getAttribute('src'),'data:image/png;base64,AQ==')
  assert.equal(heading.firstElementChild===img,true)
  assert.equal(heading.textContent,'one')
  assert.equal(img?.alt,'');assert.equal(img?.draggable,false)
})

test('centered Quick chat header carries the same optional org logo',async t=>{
  fetchFor(t,async()=>response('Ag=='))
  const v=await mountView(title('one','r1',true),el=>el);t.after(()=>v.unmount());await settle()
  assert.equal(v.el.querySelectorAll('.shell-header-start .shell-header-title img.org-header-logo').length,1)
})

test('logo revisions update and removal leaves only the title with no placeholder',async t=>{
  let current:string|null='AQ==';let reads=0
  fetchFor(t,async()=>{reads++;return response(current)})
  const v=await mountView(title(),el=>el);t.after(()=>v.unmount());await settle()
  assert.equal(logo(v.el)?.getAttribute('src'),'data:image/png;base64,AQ==')
  current='Ag==';await v.render(title('one','r2'));await settle()
  assert.equal(logo(v.el)?.getAttribute('src'),'data:image/png;base64,Ag==')
  current=null;await v.render(title('one','r3'));await settle()
  assert.equal(logo(v.el)===null,true)
  assert.equal(v.el.querySelector('.shell-header-title')!.childElementCount,0)
  assert.equal(v.el.querySelector('.shell-header-title')!.textContent,'one')
  assert.equal(reads,3)
})

test('late previous-org logo cannot replace the switched org',async t=>{
  let resolve!:(r:Response)=>void
  const pending=new Promise<Response>(r=>{resolve=r})
  fetchFor(t,async url=>String(url).includes('/one/')?pending:response('Ag=='))
  const v=await mountView(title(),el=>el);t.after(()=>v.unmount())
  await v.render(title('two','r1'));await settle()
  assert.equal(logo(v.el)?.getAttribute('src'),'data:image/png;base64,Ag==')
  await inAct(()=>{resolve(response('AQ=='))});await settle()
  assert.equal(logo(v.el)?.getAttribute('src'),'data:image/png;base64,Ag==')
  assert.equal(v.el.querySelector('.shell-header-title')!.textContent,'two')
})

test('adopted document header keeps logo updates in its own title',async t=>{
  let current='AQ=='
  fetchFor(t,async()=>response(current))
  const detached=document.implementation.createHTMLDocument('Synthetic pop-out')
  const v=await mountView(createPortal(title(),detached.body),el=>el);t.after(()=>v.unmount());await settle()
  assert.equal(logo(detached.body)?.ownerDocument===detached,true)
  current='Ag==';await v.render(createPortal(title('one','r2'),detached.body));await settle()
  assert.equal(logo(detached.body)?.getAttribute('src'),'data:image/png;base64,Ag==')
})

test('Home and an org without a revision keep plain titles and do no logo reads',async t=>{
  let reads=0;fetchFor(t,async()=>{reads++;return response(null)})
  const v=await mountView(<ShellHeader menu={null} title="Home" />,el=>el);t.after(()=>v.unmount());await settle()
  await v.render(title('none',null));await settle()
  assert.equal(logo(v.el)===null,true);assert.equal(reads,0)
  assert.equal(v.el.querySelector('.shell-header-title')!.childElementCount,0)
})

test('failed logo reads leave a usable title without an empty image',async t=>{
  fetchFor(t,async()=>response(null,503))
  const v=await mountView(title(),el=>el);t.after(()=>v.unmount());await settle()
  assert.equal(logo(v.el)===null,true)
  assert.equal(v.el.querySelector('.shell-header-title')!.textContent,'one')
})

test('main, legacy and pop-out org settings titles receive live org identity',()=>{
  const source=readFileSync(path.join(__SRC_DIR__,'App.tsx'),'utf8')
  assert.equal(source.includes('orgSlug={tree.slug} logoRevision={tree.net?.picture_revision}'),true)
  assert.equal(source.split('<OrgHeaderLogo slug={tree.slug} revision={tree.net?.picture_revision} />{tree.name}').length-1,2)
})
