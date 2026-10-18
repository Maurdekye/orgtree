module.exports = async page => {
  await page.resize('950x540'); await page.goto('/')
  await page.waitFor('.mailrow .queue-delivery')
  await page.eval(() => {
    const s=document.createElement('style');s.textContent='.mailer-list{width:350px;min-width:350px;max-width:350px}body{margin:0;background:var(--bg);color:var(--ink)}';document.head.appendChild(s)
    document.querySelector('.mailrow').click()
  })
  await page.eval(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve,120)))))
  const metrics=await page.eval(() => ({
    listWidth:document.querySelector('.mailer-list').getBoundingClientRect().width,
    rows:[...document.querySelectorAll('.mailrow')].map(row => {
      const sender=row.querySelector('.mfrom .cc-name'),marker=row.querySelector('.queue-delivery'),link=marker.querySelector('.cc-name')
      return {sender:sender.textContent,senderWidth:sender.clientWidth,senderTextWidth:sender.scrollWidth,
        markerWidth:marker.getBoundingClientRect().width,recipientWidth:link.clientWidth,recipientTextWidth:link.scrollWidth,
        rowWidth:row.clientWidth,rowTextWidth:row.scrollWidth,kind:row.querySelector('.event-row-kind')?.textContent,
        tooltip:marker.title,linked:link.getAttribute('data-agent-nav')}
    }),paneLink:document.querySelector('.mailer-head .queue-delivery [data-agent-nav]')?.textContent
  }))
  if(metrics.listWidth!==350 || metrics.rows.some(r=>r.senderTextWidth>r.senderWidth+1||r.rowTextWidth>r.rowWidth+1||r.linked!=='coordinator-opus')
    ||!metrics.rows.some(r=>r.kind==='Question')||!metrics.rows.every(r=>r.recipientTextWidth>r.recipientWidth)||!metrics.paneLink) throw Error('Delivery layout: '+JSON.stringify(metrics))
  await page.screenshot('project-delivery-350px')
  return metrics
}
