module.exports=async page=>{
  const results=[]
  const paint=()=>page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,80))})
  for(const contrast of ['dark','light']){
    await page.resize('980x680');await page.goto('/')
    await page.eval(light=>document.documentElement.classList.toggle('contrast-light',light),contrast==='light')
    await page.waitFor('.mailer-head .mail-tag')
    const measure=await page.eval(()=>{
      const first=document.querySelector('#narrow-row > .mailrow'),base=document.querySelector('#baseline-row .mailrow')
      const rect=e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right}}
      const pills=[...document.querySelectorAll('.mail-tag')].map(e=>{const s=getComputedStyle(e);return {text:e.textContent,font:s.fontSize,whiteSpace:s.whiteSpace,ellipsis:s.textOverflow,...rect(e)}})
      return {pills,headerPills:first.querySelector('.l1').querySelectorAll('.mail-tag').length,
        rowPills:first.querySelectorAll('.mail-tag[data-tag-key]').length,more:first.querySelector('.mail-tag-more')?.textContent,
        sender:rect(first.querySelector('.mfrom')),baseline:rect(base.querySelector('.mfrom')),
        replyKind:document.querySelector('#read-pane .mailer-head').textContent.includes('Mail reply'),
        quote:document.querySelector('#read-pane .reply-preview')?.textContent.includes('In reply to')}
    })
    if(measure.pills.some(p=>p.font!=='10px'||p.whiteSpace!=='nowrap'||p.ellipsis!=='ellipsis'||p.height>18))throw new Error('oversized/wrapping tag '+JSON.stringify(measure))
    if(measure.headerPills!==0||measure.rowPills!==1||measure.more!=='+7'||Math.abs(measure.sender.width-measure.baseline.width)>.1||measure.replyKind||!measure.quote)throw new Error('mail layout contract '+JSON.stringify(measure))
    await paint();await page.screenshot(`mail-tags-${contrast}`)
    await page.eval(()=>document.querySelector('button[aria-label="Filter mail by tags"]').click())
    await page.waitFor('.mail-tag-choice')
    const options=await page.eval(()=>{
      const popup=document.querySelector('.mail-tag-popover'),r=popup.getBoundingClientRect()
      const cards=[...popup.querySelectorAll('.mail-tag-choice')].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {font:s.fontSize,whiteSpace:s.whiteSpace,height:r.height,top:r.top,selected:e.getAttribute('aria-pressed')}})
      return {cards,rows:new Set(cards.map(c=>c.top)).size,inViewport:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}
    })
    if(!options.inViewport||options.cards.length!==8||options.rows<2||options.cards.filter(c=>c.selected==='true').length!==2||options.cards.some(c=>c.font!=='10px'||c.whiteSpace!=='nowrap'||c.height>18))throw new Error('tag toggle layout '+JSON.stringify(options))
    await paint();await page.screenshot(`mail-tags-filter-${contrast}`)
    results.push({contrast,...measure,options})
  }
  return results
}
