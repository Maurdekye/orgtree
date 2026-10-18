import { inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { MailList } from '../src/canvas/mail'
import type { MailRow } from '../src/canvas/shared'

// The inbox filter bar is ONE field (user 2026-10-18 11:32Z: "it does not look
// good"): the tag trigger, the selected chips, the text filter and the clear
// button sit inside a single bordered control instead of three boxes. Styling
// and structure only: every behaviour below is the one the bar already had.

declare const __SRC_DIR__:string
const choices=['Alpha Build','Progress','Review']
const rows:MailRow[]=Array.from({length:6},(_,i)=>({id:`m${i}`,from:'lead',kind:'message',
  at:`2026-10-18T10:00:0${i}Z`,body:`message ${i}`,...(i<3?{tags:i===2?['Progress']:['Alpha Build','Progress']}:{}),
}))
function Inbox({initial=[] as string[]}){
  const [selected,setSelected]=useState(initial)
  return <MailList delivered={rows} tagFilter={{selected,choices,onChange:setSelected}}/>
}
const field=(el:HTMLElement)=>el.querySelector<HTMLElement>('.mail-list-controls .mail-tag-control')
const trigger=(el:HTMLElement)=>el.querySelector<HTMLButtonElement>('button[aria-label="Filter mail by tags"]')
const count=(el:HTMLElement)=>el.querySelectorAll('.mailrow').length
const type=(input:HTMLInputElement,value:string)=>{
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')!.set!.call(input,value)
  input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input',{bubbles:true}))
}
const part=(e:Element)=>e.matches('button.mail-tag-trigger')?'trigger':e.matches('button.mail-tag-active')?'chip'
  :e.matches('input.mail-filter')?'filter':e.matches('button.mail-tag-clear')?'clear':'other'

test('the inbox filter bar is one field holding the tag trigger, chips, text filter and clear',async()=>{
  const v=await mountView(<Inbox initial={['Alpha Build','Progress']}/>,el=>el)
  try{
    const controls=v.el.querySelector<HTMLElement>('.mail-list-controls');assert.ok(controls,'positive control: the bar renders')
    assert.equal(controls.querySelectorAll('.mail-tag-control').length,1,'one field')
    const box=field(v.el);assert.ok(box)
    assert.equal(controls.querySelectorAll('input.mail-filter').length,1)
    assert.ok(box.querySelector('input.mail-filter'),'the text filter sits inside the field, not beside it')
    assert.ok(box.querySelector('button[aria-label="Clear tag filter"]'),'the clear button sits inside the field')
    const order=[...box.querySelectorAll('button.mail-tag-trigger,button.mail-tag-active,input.mail-filter,button.mail-tag-clear')].map(part)
    assert.deepEqual(order,['trigger','chip','chip','filter','clear'])
    assert.equal(box.lastElementChild?.matches('button.mail-tag-clear'),true,'clear is the field\'s right end')
    assert.equal(box.querySelector('button button')===null,true,'chips and controls are never nested buttons')
  }finally{await v.unmount()}
})

test('the tag trigger is a quiet icon that names an empty selection',async()=>{
  const v=await mountView(<Inbox/>,el=>el)
  try{
    const empty=trigger(v.el);assert.ok(empty,'positive control: the trigger renders')
    assert.ok(empty.querySelector('svg'),'the trigger carries a tag icon')
    assert.equal(empty.textContent?.trim(),'all tags','an empty selection still reads as all tags')
    assert.equal(v.el.querySelectorAll('button.mail-tag-active').length,0)
  }finally{await v.unmount()}
  const w=await mountView(<Inbox initial={['Progress']}/>,el=>el)
  try{
    const chosen=trigger(w.el);assert.ok(chosen)
    assert.ok(chosen.querySelector('svg'),'the icon stays when tags are chosen')
    assert.equal(chosen.textContent?.trim(),'','the chosen tags show as chips beside the icon, not inside it')
    assert.equal(w.el.querySelector('.mail-tag-control button.mail-tag-active')?.textContent,'Progress')
  }finally{await w.unmount()}
})

test('typing in the inline filter and clearing tags keep their behaviour',async()=>{
  const v=await mountView(<Inbox initial={['Alpha Build']}/>,el=>el)
  try{
    assert.equal(count(v.el),2,'positive control: the tag filter applies')
    const input=v.el.querySelector<HTMLInputElement>('.mail-list-controls input.mail-filter');assert.ok(input)
    assert.equal(input.placeholder,'filter…')
    await inAct(()=>type(input,'message 1'))
    assert.equal(count(v.el),1,'text and tag filters intersect')
    const clear=v.el.querySelector<HTMLButtonElement>('button[aria-label="Clear tag filter"]');assert.ok(clear)
    assert.equal(clear.textContent?.trim(),'×')
    await inAct(()=>clear.click())
    assert.equal(v.el.querySelectorAll('button.mail-tag-active').length,0,'clear removes every tag')
    assert.equal(v.el.querySelector<HTMLInputElement>('input.mail-filter')?.value,'message 1','clear leaves the typed text alone')
    assert.equal(count(v.el),1)
    assert.equal(document.activeElement===trigger(v.el),true,'focus returns to the tag trigger')
    assert.equal(v.el.querySelector('button[aria-label="Clear tag filter"]')===null,true,'nothing to clear, no clear button')
  }finally{await v.unmount()}
})

test('a mailbox without tags keeps one standalone filter field',async()=>{
  const v=await mountView(<MailList delivered={rows}/>,el=>el)
  try{
    const controls=v.el.querySelector<HTMLElement>('.mail-list-controls');assert.ok(controls,'positive control: six rows show the filter')
    assert.equal(controls.querySelector(':scope > input.mail-filter')!==null,true)
    assert.equal(controls.querySelector('.mail-tag-control')===null,true)
    assert.equal(trigger(v.el)===null,true)
  }finally{await v.unmount()}
})

test('pressed tag choices carry a check mark, not only a colour change',async()=>{
  const v=await mountView(<Inbox initial={['Progress']}/>,el=>el)
  try{
    const button=trigger(v.el);assert.ok(button)
    await inAct(()=>button.click())
    const cards=[...v.el.ownerDocument.querySelectorAll<HTMLButtonElement>('button.mail-tag-choice')]
    assert.equal(cards.length,3,'positive control: the popover lists every choice')
    for(const card of cards){
      const on=card.getAttribute('aria-pressed')==='true'
      assert.equal(on,card.textContent==='Progress',card.textContent??'')
      assert.equal(card.querySelector('svg')!==null,on,`${card.textContent}: a check marks only the pressed choice`)
    }
  }finally{await v.unmount()}
})

// The popover takes its field's width, from 240px up to 320px, so it opens
// inside the list column instead of running past a narrower field
// (coordinator-opus 2026-10-18 12:09Z). The viewport cap still wins.
async function popoverFor(fieldWidth:number,innerWidth?:number){
  const v=await mountView(<Inbox initial={['Progress']}/>,el=>el)
  const win=v.el.ownerDocument.defaultView!,real=Object.getOwnPropertyDescriptor(win,'innerWidth')
  if(innerWidth!==undefined)Object.defineProperty(win,'innerWidth',{value:innerWidth,configurable:true})
  try{
    const box=field(v.el);assert.ok(box,'positive control: the field renders')
    const rect={left:40,top:70,right:40+fieldWidth,bottom:94,width:fieldWidth,height:24,x:40,y:70}
    Object.defineProperty(box,'getBoundingClientRect',{value:()=>({...rect,toJSON:()=>rect}),configurable:true})
    await inAct(()=>trigger(v.el)!.click())
    const pop=v.el.ownerDocument.querySelector<HTMLElement>('.mail-tag-popover');assert.ok(pop,'positive control: the popover opens')
    return {width:pop.style.width,left:pop.style.left,top:pop.style.top}
  }finally{
    if(innerWidth!==undefined){if(real)Object.defineProperty(win,'innerWidth',real);else delete (win as {innerWidth?:number}).innerWidth}
    await v.unmount()
  }
}
test('the tag popover takes its field width between 240 and 320 pixels',async()=>{
  assert.deepEqual(await popoverFor(300),{width:'300px',left:'40px',top:'98px'},'a 300px field gets a 300px popover under it')
  assert.equal((await popoverFor(180)).width,'240px','a narrow field keeps a usable 240px popover')
  assert.equal((await popoverFor(420)).width,'320px','a wide field caps the popover at 320px')
  assert.equal((await popoverFor(300,260)).width,'236px','the viewport cap still wins')
})

// ---------------------------------------------------------------- palette
// Chips keep the shared name-derived OKLCH hue (canvas/mailtags.ts) and take
// lightness/chroma/alpha from one palette per contrast family. The old opaque
// L 0.88 C 0.12 fill sat outside sRGB for most hues, so Chromium clipped it to
// neon, and on dark surfaces it was a bright block. A calm chip is a tint close
// to its surface whose TEXT carries the hue at AA contrast on every surface.
const css=readFileSync(path.join(__SRC_DIR__,'styles.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'')
const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m=>({selector:m[1]!.trim(),body:m[2]!}))
const prop=(body:string,name:string)=>body.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+)`))?.[1]?.trim()
function tokens(selector:string,needs:string){
  const rule=rules.find(r=>r.selector===selector&&prop(r.body,needs)!==undefined)
  assert.ok(rule,`${selector} defines ${needs}`)
  return (name:string)=>{const v=prop(rule.body,name);assert.ok(v!==undefined,`${selector} ${name}`);return v}
}
function linear(L:number,C:number,h:number){
  const a=C*Math.cos(h*Math.PI/180),b=C*Math.sin(h*Math.PI/180)
  const l=(L+0.3963377774*a+0.2158037573*b)**3,m=(L-0.1055613458*a-0.0638541728*b)**3,s=(L-0.0894841775*a-1.2914855480*b)**3
  return [4.0767416621*l-3.3077115913*m+0.2309699292*s,-1.2684380046*l+2.6097574011*m-0.3413193965*s,-0.0041960863*l-0.7034186147*m+1.7076147010*s]
}
const encode=(c:number)=>c<=0.0031308?12.92*c:1.055*c**(1/2.4)-0.055,decode=(c:number)=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4
const hex=(h:string)=>[1,3,5].map(i=>decode(parseInt(h.slice(i,i+2),16)/255))
// browsers blend alpha in encoded sRGB
const over=(fg:number[],alpha:number,bg:number[])=>fg.map((c,i)=>decode(encode(c)*alpha+encode(bg[i]!)*(1-alpha)))
const lum=(c:number[])=>0.2126*c[0]!+0.7152*c[1]!+0.0722*c[2]!
const ratio=(a:number[],b:number[])=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x!+0.05)/(y!+0.05)}
const pair=(v:string)=>{const [L,C]=v.split(/\s+/).map(Number);assert.ok(Number.isFinite(L)&&Number.isFinite(C),v);return [L!,C!] as const}
const themes=[
  {name:'charcoal',surfaces:':root',palette:':root'},
  {name:'obsidian',surfaces:':root.contrast-obsidian-black',palette:':root'},
  {name:'light',surfaces:':root.contrast-light',palette:':root:is(.contrast-light, .contrast-solarized-light)'},
  {name:'solarized',surfaces:':root.contrast-solarized-light',palette:':root:is(.contrast-light, .contrast-solarized-light)'},
]

test('tag chips use an in-gamut pastel palette with AA text on every theme surface',()=>{
  for(const theme of themes){
    const surface=tokens(theme.surfaces,'--bg'),palette=tokens(theme.palette,'--mail-tag-ink')
    const surfaces=['--bg','--input','--panel','--panel-2'].map(n=>({n,c:hex(surface(n))}))
    const [inkL,inkC]=pair(palette('--mail-tag-ink')),[tintL,tintC]=pair(palette('--mail-tag-tint'))
    const fills=['--mail-tag-fill','--mail-tag-fill-on'].map(n=>({n,a:Number(palette(n))})),edge=Number(palette('--mail-tag-edge'))
    for(const f of fills)assert.ok(f.a>0&&f.a<=0.35,`${theme.name} ${f.n} stays a tint (${f.a})`)
    assert.ok(edge>0&&edge<=1,`${theme.name} --mail-tag-edge`)
    for(let h=0;h<360;h++){
      for(const [what,L,C] of [['ink',inkL,inkC],['tint',tintL,tintC]] as const)
        assert.ok(linear(L,C,h).every(c=>c>=-1e-4&&c<=1+1e-4),`${theme.name} ${what} oklch(${L} ${C} ${h}) is outside sRGB and would clip`)
      const ink=linear(inkL,inkC,h),tint=linear(tintL,tintC,h)
      for(const s of surfaces)for(const f of fills){
        const chip=over(tint,f.a,s.c)
        assert.ok(ratio(ink,chip)>=4.5,`${theme.name} hue ${h} ${f.n} on ${s.n}: text ${ratio(ink,chip).toFixed(2)}:1`)
        assert.ok(ratio(chip,s.c)<=1.6,`${theme.name} hue ${h} ${f.n} on ${s.n}: the fill is a tint, not a block (${ratio(chip,s.c).toFixed(2)}:1)`)
      }
    }
  }
})

test('every chip surface draws its colours from that palette',()=>{
  const chip=rules.find(r=>r.selector.split(',').map(s=>s.trim()).includes('.mail-tag'));assert.ok(chip,'the shared .mail-tag rule')
  assert.match(prop(chip.body,'color')??'',/^oklch\(var\(--mail-tag-ink\) var\(--mail-tag-hue/)
  assert.match(prop(chip.body,'background')??'',/^oklch\(var\(--mail-tag-tint\) var\(--mail-tag-hue[^)]*\) \/ var\(--mail-tag-fill\)\)/)
  assert.match(prop(chip.body,'border')??'',/oklch\(var\(--mail-tag-tint\) var\(--mail-tag-hue[^)]*\) \/ var\(--mail-tag-edge\)\)/)
  assert.equal(prop(chip.body,'font-size'),'10px','one 10px pill on every surface')
  assert.equal(prop(chip.body,'font-family'),'var(--sans)','the mono mail header does not change the chip face')
})
