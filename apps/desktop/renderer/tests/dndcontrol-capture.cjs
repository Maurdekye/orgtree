module.exports=async page=>{
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('.cc-head-top .dnd-control',{timeout:5000})
  const details=await page.eval(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))
    const button=document.querySelector('.cc-head-top .dnd-control')
    const rect=button.getBoundingClientRect()
    return {label:button.textContent,pressed:button.getAttribute('aria-pressed'),
      badge:document.querySelector('.cc-head-meta .dnd-badge')?.textContent,
      urgent:!!document.querySelector('.cc-urgent-toggle'),
      box:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:{width:innerWidth,height:innerHeight}}
  })
  if(details.label!=='DND next turn'||details.badge!=='DND next turn'||details.pressed!=='true'||details.urgent
    ||details.box.width<=0||details.box.x<0||details.box.x+details.box.width>details.viewport.width)
    throw new Error(JSON.stringify(details))
  return {details,screenshots:[await page.screenshot('dnd-next-turn-desk')]}
}
