module.exports=async page=>{
  await page.resize('1240x420');await page.goto('/')
  await page.waitFor('[data-fixture="row"] .badge')
  const v=await page.eval(()=>{
    const bs=[...document.querySelectorAll('[data-fixture="row"] .badge')]
    const pick=bs.find(b=>/integration-queue/.test(b.textContent))??bs[bs.length-1]
    document.querySelector('output').textContent='Hover text of "'+pick.textContent.trim()+'":\n'+pick.title
    return {badges:bs.map(b=>({text:b.textContent.trim(),title:b.title})),rowHeight:document.querySelector('[data-fixture="row"]').getBoundingClientRect().height}
  })
  const paint=()=>page.eval(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200)))))
  await paint();await page.screenshot('inherited-audience-badges')
  // activation like a project mention: a real mouse click, then real keyboard Enter on the focused link
  const link=await page.eval(()=>{const l=[...document.querySelectorAll('[data-fixture="row"] .badge button.aud-via-link')].find(b=>/integration-queue/.test(b.textContent));if(!l)return null;const r=l.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,title:l.title}})
  if(!link)throw Error('no project link in the badge')
  await page.click({x:link.x,y:link.y});await paint()
  v.afterClick=await page.eval(()=>window.__jumps?.slice()??[])
  await page.eval(()=>{document.activeElement?.blur();document.querySelector('[data-fixture="row"] .badge button.aud-via-link').focus()})
  await page.press('Enter');await paint()
  v.afterEnter=await page.eval(()=>window.__jumps?.slice()??[])
  v.focused=await page.eval(()=>document.activeElement?.className)
  await page.screenshot('inherited-audience-badge-focused')
  if(v.afterClick.join()!=='integration-queue'||v.afterEnter.join()!=='integration-queue,integration-queue')throw Error('activation '+JSON.stringify(v))
  return v
}
