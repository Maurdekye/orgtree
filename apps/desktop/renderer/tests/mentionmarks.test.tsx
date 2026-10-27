// tests/mentionmarks.test.tsx — USER 2026-10-27 m6d0cdc7a2be6 "style the mention uniquely ... like how agent
// mentions aee styled" and m33e4a043b457 "tickets / presentations ... with an icon to the left lkke agent links":
// every mention kind wears its own icon on the left. Agents keep their model badge and projects their folder; a
// docket item, a document, an app and a panel each get their app icon. React chips and the DOM chips of rendered
// Markdown draw the same mark, and a failed reference keeps showing the token it was written as, with no mark.
import {mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {RefChip,resolveRef} from '../src/canvas/reflinks'
import type {RefWorld} from '../src/canvas/reflinks'
import {linkifyRefs} from '../src/canvas/refmd'
import {WorkRefText,buildMentionIndex,parseRef} from '../src/canvas/workrefs'
import {REF_MARK_PATHS} from '../src/canvas/refmarks'

declare const __SRC_DIR__:string
const noop=()=>{}
const world:RefWorld={org:'acme',agents:new Map([['dev','dev'],['crew','crew']]),tierOf:id=>id==='crew'?'project':'opus',
 appRef:r=>({outcome:'ready',label:r.kind==='app'?'Notes':'Notes · Panel 1',title:'Off'})}
// token → what its chip's first element is
const KINDS:[string,string][]=[['@agent:acme/dev','tier'],['@agent:acme/crew','project-mark'],['@item:acme/build-docs','ref-mark-item'],
 ['@doc:acme/d1','ref-mark-doc'],['@app:acme/notes','ref-mark-app'],['@panel:acme/one','ref-mark-panel']]
const lead=(chip:Element)=>chip.firstElementChild
const markOf=(chip:Element)=>chip.querySelector('.ref-mark')

test('every mention kind wears its own mark on the left, in React and in rendered Markdown alike',async t=>{
 const host=document.createElement('div');document.body.appendChild(host);t.after(()=>host.remove())
 host.innerHTML=`<p>${KINDS.map(([token])=>token).join(' and ')}</p>`
 assert.equal(linkifyRefs(host,world,true),KINDS.length)
 const dom=[...host.querySelectorAll('.ref-chip')]
 for(const [i,[token,cls]] of KINDS.entries()){
  const view=await mountView(<RefChip r={resolveRef(parseRef(token)!,world)} onOpen={noop}/>,el=>el);t.after(()=>view.unmount())
  const chip=view.el.firstElementChild!
  assert.ok(lead(chip)?.classList.contains(cls),`${token}: React chip leads with .${cls}, got ${lead(chip)?.className}`)
  assert.ok(lead(dom[i]!)?.classList.contains(cls),`${token}: Markdown chip leads with .${cls}, got ${lead(dom[i]!)?.className}`)
  const kind=cls.startsWith('ref-mark-')?cls.slice(9) as keyof typeof REF_MARK_PATHS:null
  if(!kind)continue
  assert.equal(markOf(chip)!.querySelector('path')!.getAttribute('d'),REF_MARK_PATHS[kind],`${token}: the kind's own icon`)
  assert.equal(markOf(chip)!.outerHTML,markOf(dom[i]!)!.outerHTML,`${token}: one mark, drawn the same way twice`)
  assert.equal(markOf(chip)!.getAttribute('aria-hidden'),'true','the name is the accessible text')
  assert.equal(chip.textContent,dom[i]!.textContent,`${token}: same name`)
 }
 // six kinds, six different marks
 assert.equal(new Set(KINDS.map(([,cls])=>cls)).size,6)
})

test('a failed reference shows its token and verdict, with no mark; an inert resolved one keeps it',async t=>{
 const gone=resolveRef(parseRef('@item:acme/gone')!,{...world,items:new Map()})
 const failed=await mountView(<RefChip r={gone} onOpen={noop}/>,el=>el);t.after(()=>failed.unmount())
 assert.equal(failed.el.querySelector('.ref-mark'),null)
 assert.equal(failed.el.textContent,'@item:acme/goneunavailable')
 const inert=await mountView(<RefChip r={resolveRef(parseRef('@app:acme/notes')!,world)}/>,el=>el);t.after(()=>inert.unmount())
 assert.deepEqual([inert.el.firstElementChild!.tagName,!!inert.el.querySelector('.ref-mark-app')],['SPAN',true])
})

test('a docket item named in prose wears the same docket mark, wherever it is a link',async t=>{
 const index=buildMentionIndex([{slug:'build-docs',title:'Build the docs'}])
 const live=await mountView(<WorkRefText text="see build-docs today" index={index} onPick={noop}/>,el=>el);t.after(()=>live.unmount())
 const button=live.el.querySelector('button.docket-ref')!
 assert.ok(lead(button)?.classList.contains('ref-mark-item'))
 assert.equal(button.textContent,'build-docs')
 const host=document.createElement('div');document.body.appendChild(host);t.after(()=>host.remove())
 host.innerHTML='<p>see build-docs today</p>'
 linkifyRefs(host,world,true,{index,onPick:noop})
 const chip=host.querySelector('[data-ref-mention="build-docs"]')!
 assert.equal(markOf(chip)!.outerHTML,markOf(button)!.outerHTML)
 // a name that is not a link stays plain text
 const plain=await mountView(<WorkRefText text="see build-docs today" index={index}/>,el=>el);t.after(()=>plain.unmount())
 assert.equal(plain.el.querySelector('.ref-mark'),null)
})

test('the mention styles use only theme variables the stylesheet defines',()=>{
 // an undefined var() drops its whole declaration silently (AGENTS.md, apps.css 2026-10-26)
 const css=readFileSync(path.join(__SRC_DIR__,'styles.css'),'utf8')
 const start=css.indexOf('EVERY MENTION WEARS ITS KIND ON THE LEFT'),end=css.indexOf('.ref-chip.ref-hub {',start)
 assert.ok(start>0&&end>start,'the mention mark rules are present')
 const used=[...css.slice(start,end).matchAll(/var\((--[a-z0-9-]+)/g)].map(m=>m[1]!)
 assert.ok(used.length>=3,'the rules read theme colours')
 for(const name of used)assert.ok(new RegExp(`${name}\\s*:`).test(css),`${name} is defined`)
})
