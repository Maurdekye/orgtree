module.exports = async page => {
  await page.resize('1000x700'); await page.goto('/')
  await page.waitFor('[role="dialog"]')
  const settle = () => page.eval(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); await new Promise(r => setTimeout(r, 80)) })
  const layout = () => page.eval(() => {
    const dialog=document.querySelector('[role="dialog"]'), r=dialog.getBoundingClientRect()
    const body=dialog.querySelector('.confirm-body'), footer=dialog.querySelector('.row')
    const fr=footer.getBoundingClientRect(), br=body.getBoundingClientRect()
    const controls=[...footer.querySelectorAll('button')].map(b=>{
      const rect=b.getBoundingClientRect(), hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)
      return {label:b.textContent,visible:rect.top>=r.top&&rect.bottom<=r.bottom&&rect.left>=r.left&&rect.right<=r.right&&!!hit&&(hit===b||b.contains(hit))}
    })
    return {width:r.width,inViewport:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,
      bodyBeforeFooter:br.bottom<=fr.top+1,bodyOverflow:getComputedStyle(body).overflowY,
      bodyScrolls:body.scrollHeight>body.clientHeight,footerTop:fr.top,controls}
  })
  await settle()
  const desktop=await layout()
  if(!desktop.inViewport||Math.abs(desktop.width-620)>1||!desktop.bodyBeforeFooter||desktop.controls.some(b=>!b.visible))
    throw new Error('Desktop bulk footer clipped '+JSON.stringify(desktop))
  await page.resize('400x520'); await settle()
  const compact=await layout()
  await page.eval(()=>{const body=document.querySelector('.confirm-body');body.scrollTop=body.scrollHeight})
  const scrolled=await layout()
  if(!compact.inViewport||Math.abs(compact.width-360)>1||compact.bodyOverflow!=='auto'||!compact.bodyScrolls
    ||!compact.bodyBeforeFooter||compact.controls.some(b=>!b.visible)||Math.abs(compact.footerTop-scrolled.footerTop)>1)
    throw new Error('Compact bulk body/footer geometry failed '+JSON.stringify({compact,scrolled}))
  await page.resize('1000x700'); await settle()
  const value = await page.eval(() => {
    const dialog = document.querySelector('[role="dialog"]'), rect = dialog.getBoundingClientRect()
    return { ...rect.toJSON(), text: dialog.textContent, radios: dialog.querySelectorAll('input[type="radio"]').length,
      buttons: [...dialog.querySelectorAll('.row > button')].map(b => ({ label:b.textContent,disabled:b.disabled })),
      sections: dialog.querySelectorAll('[data-compact-preview]').length,
      inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight }
  })
  if(value.radios || value.sections!==2 || !value.inViewport
    || JSON.stringify(value.buttons)!==JSON.stringify([{label:'compact 2 agents',disabled:false},{label:'cheap-compact 4 agents',disabled:false},{label:'cancel',disabled:false}])
    || !value.text.includes('Codex') || !value.text.includes('busy-worker') || !value.text.includes('new-worker'))
    throw new Error('Two-action preview failed '+JSON.stringify(value))
  await page.screenshot('bulk-compact-two-actions')
  return { ...value, layout: { desktop, compact, scrolled } }
}
