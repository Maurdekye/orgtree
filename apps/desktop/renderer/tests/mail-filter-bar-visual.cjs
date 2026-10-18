// Page script for mail-filter-bar-visual.mjs (tools/rig/desktop driver): the
// inbox filter bar in five states and both contrast families. Full frames at
// 1x plus 2x close-ups of the list column; metrics are returned for the
// runner to compare. No assertions here, so the same script records a base.
const fs=require('node:fs'),path=require('node:path')
const W=1000,H=660
module.exports=async(page,{out})=>{
  const paint=()=>page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,120))})
  const set=async mode=>{await page.eval(m=>window.__filterBar.set(m),mode);await paint()}
  // the pointer rests outside the probe, so no hover state leaks into a frame
  const park=async()=>{await page.mouse('mouseMoved',W-4,H-4);await paint()}
  const metrics=()=>page.eval(()=>{
    const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,cy:r.y+r.height/2}}
    const clear=c=>/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(c)
    const bar=document.querySelector('.mail-list-controls')
    const parts=bar?[...bar.querySelectorAll('*')].filter(e=>!e.closest('.mail-tag')&&e.getBoundingClientRect().width>0):[]
    const label=e=>e.tagName.toLowerCase()+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\s+/).join('.'):'')
    const boxes=parts.filter(e=>{const s=getComputedStyle(e);return parseFloat(s.borderTopWidth)>0&&s.borderTopStyle!=='none'&&!clear(s.borderTopColor)}).map(label)
    const fills=parts.filter(e=>!clear(getComputedStyle(e).backgroundColor)).map(label)
    const style=e=>{if(!e)return null;const s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor,border:s.borderTopColor,font:s.fontSize,family:s.fontFamily.split(',')[0],radius:s.borderTopLeftRadius,...rect(e)}}
    const rows=[...document.querySelectorAll('.mailrow')].map(r=>({text:r.querySelector('.mfrom')?.textContent,l1:rect(r.querySelector('.l1'))?.h,
      l2:rect(r.querySelector('.l2'))?.h,chips:r.querySelectorAll('.l2 .mail-tag').length,h:rect(r)?.h}))
    const popover=document.querySelector('.mail-tag-popover')
    return {bar:rect(bar),boxes,fills,field:rect(document.querySelector('.mail-list-controls .mail-tag-control')),
      trigger:rect(document.querySelector('.mail-list-controls button[aria-label="Filter mail by tags"]')),
      triggerText:document.querySelector('.mail-list-controls button[aria-label="Filter mail by tags"]')?.textContent?.trim()??null,
      chips:[...document.querySelectorAll('.mail-list-controls .mail-tag')].map(style),
      input:rect(bar?.querySelector('input.mail-filter')),clear:rect(bar?.querySelector('button.mail-tag-clear')),
      rowChip:style(document.querySelector('.mailrow .l2 .mail-tag[data-tag-key]')),more:style(document.querySelector('.mailrow .mail-tag-more')),
      headChip:style(document.querySelector('.mailer-head .mail-tag')),rows,
      popover:popover?{box:rect(popover),search:rect(popover.querySelector('input')),
        choices:[...popover.querySelectorAll('.mail-tag-choice')].map(e=>({...style(e),text:e.textContent,pressed:e.getAttribute('aria-pressed'),check:!!e.querySelector('svg')}))}:null,
      focus:document.activeElement?label(document.activeElement):null}
  })
  const closeup=async(name,height)=>{
    const list=await page.eval(()=>{const m=document.querySelector('.mailer').getBoundingClientRect(),l=document.querySelector('.mailer-list').getBoundingClientRect();return {x:m.x,y:m.y,w:l.width}})
    await page.cdp('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:2,mobile:false,screenWidth:W,screenHeight:H});await paint()
    const shot=await page.cdp('Page.captureScreenshot',{format:'png',clip:{x:Math.max(0,list.x-8),y:Math.max(0,list.y-8),width:list.w+16,height,scale:1}})
    fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'))
    await page.cdp('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:1,mobile:false,screenWidth:W,screenHeight:H});await paint()
  }
  await page.resize(`${W}x${H}`)
  await page.waitFor('.mail-list-controls')
  const results={}
  for(const theme of ['dark','light']){
    await page.eval(light=>document.documentElement.classList.toggle('contrast-light',light),theme==='light')
    const r=results[theme]={}
    await set({tags:['alpha'],node:false});await park()
    r.selected=await metrics();await page.screenshot(`${theme}-selected`);await closeup(`${theme}-selected-2x`,200)
    await set({tags:[]});await park()
    r.empty=await metrics();await page.screenshot(`${theme}-empty`);await closeup(`${theme}-empty-2x`,200)
    await set({tags:['alpha']})
    await page.click('.mail-list-controls input.mail-filter');await page.type('built');await paint()
    r.typing=await metrics();await closeup(`${theme}-typing-2x`,140)
    await page.eval(()=>{const i=document.querySelector('.mail-list-controls input.mail-filter')
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i),'value').set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}));i.blur()})
    await paint()
    await page.click('.mail-list-controls button[aria-label="Filter mail by tags"]');await page.waitFor('.mail-tag-choice');await paint()
    r.popover=await metrics();await page.screenshot(`${theme}-popover`);await closeup(`${theme}-popover-2x`,300)
    await page.press('Escape');await page.waitFor('.mail-tag-popover',{gone:true});await paint()
    await set({node:true});await park()
    r.node=await metrics();await closeup(`${theme}-node-2x`,140)
    await set({node:false})
  }
  return results
}
