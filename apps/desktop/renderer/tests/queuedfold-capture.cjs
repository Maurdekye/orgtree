module.exports=async page=>{
  await page.resize('1000x700')
  await page.goto('/')
  await page.waitFor('[data-probe="long"] .pending-run > summary',{timeout:5000})
  const details=await page.eval(async()=>{
    const short=document.querySelector('[data-probe="short"] .pending-run')
    const long=document.querySelector('[data-probe="long"] .pending-run')
    const pause=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,150))))
    await pause()
    if(!short.open||long.open) throw new Error('Unexpected automatic queue defaults')
    short.querySelector('summary').click();await pause()
    if(short.open) throw new Error('One-message queue did not collapse')
    short.querySelector('summary').click();await pause()
    if(!short.open) throw new Error('One-message queue did not expand')
    return [short,long].map(run=>{
      const summary=run.querySelector('summary'),rect=summary.getBoundingClientRect()
      return {text:summary.textContent.trim(),open:run.open,cards:run.querySelectorAll('.pendrow').length,
        visible:!summary.hidden&&rect.width>0&&rect.height>0&&rect.x>=0&&rect.right<=innerWidth&&rect.y>=0&&rect.bottom<=innerHeight}
    })
  })
  if(details.some(row=>!row.visible)||details[0].cards!==1||details[1].cards!==6) throw new Error(JSON.stringify(details))
  return {details,screenshots:[await page.screenshot('queued-groups-always-toggle')]}
}
