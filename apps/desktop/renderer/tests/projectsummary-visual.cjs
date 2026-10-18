module.exports=async page=>{
  await page.resize('1000x650');await page.goto('/')
  await page.waitFor('.project-description-md > p')
  await page.eval(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120)))))
  const value=await page.eval(()=>{
    const box=document.querySelector('.project-description-md'),first=box.firstElementChild,b=box.getBoundingClientRect(),f=first.getBoundingClientRect(),s=getComputedStyle(box)
    return {top:f.top-b.top-parseFloat(s.borderTopWidth),left:f.left-b.left-parseFloat(s.borderLeftWidth),
      paddingTop:s.paddingTop,paddingLeft:s.paddingLeft,firstMargin:getComputedStyle(first).marginTop,
      summary:document.querySelector('[data-tab="desk"]').textContent,slots:document.querySelector('[data-tab="slots"]').textContent,
      slotsCount:!!document.querySelector('[data-tab="slots"] .tab-count'),dissolve:document.querySelector('[data-action="dissolve"]').textContent}
  })
  if(Math.abs(value.top-value.left)>0.5||value.summary!=='summary'||value.slots!=='slots'||value.slotsCount||value.dissolve!=='dissolve')
    throw Error('Summary layout '+JSON.stringify(value))
  await page.screenshot('project-summary-header')
  return value
}
