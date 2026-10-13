module.exports=async page=>{
  const results=[]
  for(const theme of ['dark','light']){
    await page.resize('1366x768');await page.goto('/')
    await page.eval(light=>document.documentElement.classList.toggle('contrast-light',light),theme==='light')
    await page.waitFor('.docket-row.on')
    const first=await page.eval(()=>({selected:document.querySelector('.docket-row.on .mfrom').textContent,
      first:document.querySelector('.docket-row .mfrom').textContent,
      details:document.querySelector('.mailer-read').textContent.includes('Details of Parent')}))
    if(first.selected!==first.first||first.selected!=='Parent'||!first.details)throw new Error('first '+JSON.stringify(first))
    await page.screenshot('docket-open-'+theme)
    await page.click('.docket-row.on')
    await page.eval(()=>window.docketFixture.update())
    await page.waitFor({selector:'.mfrom',text:'Newest ticket'})
    if(await page.eval(()=>!!document.querySelector('.docket-row.on')))throw new Error('clear was overridden')
    await page.goto('/?jump=Second%20ticket');await page.waitFor('.docket-row.on')
    const requested=await page.eval(()=>document.querySelector('.docket-row.on .mfrom').textContent)
    if(requested!=='Second ticket')throw new Error('jump overridden')
    results.push({theme,...first,clearPreserved:true,jumpPreserved:true})
  }
  return results
}
