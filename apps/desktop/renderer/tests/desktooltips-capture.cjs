module.exports=async page=>{
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('[data-probe="project"] [data-action="dissolve"]',{timeout:5000})
  const details=await page.eval(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))
    return ['worker','manager','project'].map(id=>{
      const root=document.querySelector(`[data-probe="${id}"]`)
      const buttons=[...root.querySelectorAll('.cc-head-top button')].filter(b=>b.classList.contains('dnd-control')||/^retire|^dissolve/.test(b.textContent))
      return {id,buttons:buttons.map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,title:b.title,
        visible:r.width>0&&r.height>0&&r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight}})}
    })
  })
  if(details.some(row=>!row.buttons.length||row.buttons.some(b=>!b.visible||!b.title))) throw new Error(JSON.stringify(details))
  return {details,note:'Native title text is metadata; capture shows real desk layout, not an OS hover popup.',
    screenshots:[await page.screenshot('desk-lifecycle-controls')]}
}
