module.exports=async page=>{
 await page.resize('1000x700');await page.goto('/')
 await page.waitFor('[data-desk] [data-next-turn="fast"]')
 const settle=()=>page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,80))})
 const layout=()=>page.eval(()=>{
  const composer=document.querySelector('[data-desk] .cc-composer'), group=composer.querySelector('.cc-controls')
  const cr=composer.getBoundingClientRect()
  const controls=['[data-next-turn="fast"]','.cc-fast','.cc-eff','.cc-send'].map(sel=>{
   const el=group?.querySelector(sel), r=el?.getBoundingClientRect()
   if(!el)return {sel,missing:true}
   const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
   return {sel,top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,
    visible:r.left>=cr.left&&r.right<=cr.right&&r.top>=cr.top&&r.bottom<=cr.bottom&&r.right<=innerWidth&&r.bottom<=innerHeight&&!!hit&&(hit===el||el.contains(hit))}
  })
  return {composer:cr.toJSON(),controls,direction:group&&getComputedStyle(group).flexDirection,innerWidth}
 })
 const assertLayout=(value)=>{
  if(value.direction!=='column'||value.controls.some(c=>c.missing||!c.visible||Math.abs(c.height-30)>0.1))throw new Error('Invalid composer controls '+JSON.stringify(value))
  const [badge,bolt,effort,send]=value.controls
  if(Math.abs(badge.top-bolt.top)>.1||Math.abs(effort.top-send.top)>.1||bolt.bottom>=send.top||Math.abs(bolt.right-send.right)>.1)
   throw new Error('Fast top row or effort/Send lower alignment changed '+JSON.stringify(value))
  for(const a of value.controls)for(const b of value.controls){
   if(a===b)continue
   const overlap=Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0.1
   if(overlap)throw new Error('Controls overlap '+JSON.stringify(value))
  }
 }
 await settle();const desktop=await layout();assertLayout(desktop)
 const near=await page.eval(()=>[...document.querySelectorAll('[data-fixture]')].map(section=>{
  const card=section.querySelector('.sq'),r=card.getBoundingClientRect(),queued=section.querySelector('[data-next-turn="fast"]'),q=queued?.getBoundingClientRect()
  return {id:section.dataset.fixture,text:queued?.textContent,title:queued?.title,bolt:!!section.querySelector('.badge.fast-mode'),
   fits:!q||(q.left>=r.left&&q.right<=r.right&&q.top>=r.top&&q.bottom<=r.bottom)}
 }))
 for(const row of near){
  const expected=row.id==='queued-on'||row.id==='queued-off'
  if(!!row.text!==expected||!row.fits||row.bolt!==['queued-off','matching'].includes(row.id)
   ||(expected&&(!row.text.endsWith(row.id==='queued-on'?'fast on':'fast off')||!row.title.includes('next turn'))))throw new Error('Near state mismatch '+JSON.stringify(near))
 }
 await page.screenshot('fast-toprow-desktop')
 await page.resize('400x600');await page.eval(()=>{document.querySelector('[data-near]').style.display='none'});await settle()
 const narrow=await layout();assertLayout(narrow)
 if(new Set(narrow.controls.map(c=>c.top)).size<2)throw new Error('Narrow layout lost the two-row control structure')
 await page.screenshot('fast-toprow-narrow')
 return {desktop,narrow,near}
}
