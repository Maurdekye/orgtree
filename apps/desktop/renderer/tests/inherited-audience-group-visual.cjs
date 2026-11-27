module.exports=async page=>{
  await page.resize('1240x420');await page.goto('/')
  await page.waitFor('[data-fixture="row"] .badge')
  const v=await page.eval(()=>{
    const bs=[...document.querySelectorAll('[data-fixture="row"] .badge')]
    const pick=bs.find(b=>/integration-queue/.test(b.textContent))??bs[bs.length-1]
    document.querySelector('output').textContent='Hover text of "'+pick.textContent.trim()+'":\n'+pick.title
    pick.focus()
    return {badges:bs.map(b=>({text:b.textContent.trim(),title:b.title})),rowHeight:document.querySelector('[data-fixture="row"]').getBoundingClientRect().height}
  })
  await page.eval(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200)))))
  await page.screenshot('inherited-audience-badges')
  return v
}
