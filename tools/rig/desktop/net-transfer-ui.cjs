module.exports = async (page,{args}) => {
  const card=id=>`.transfer-card[data-transfer-id="${id}"]`
  await page.waitFor('.sq.orginbox')
  await page.click('.sq.orginbox')
  await page.waitFor(card(args.incoming))
  const progress=await page.eval(id=>{
    const card=document.querySelector(`[data-transfer-id="${id}"]`),p=card.querySelector('progress')
    return {value:p.value,max:p.max,text:card.innerText,state:card.dataset.transferState}
  },args.incoming)
  if(progress.value!==args.checkpoint || progress.max!==args.size || progress.state!=='downloading') throw Error(JSON.stringify(progress))
  await page.screenshot('org-inbox-progress')
  await page.click({selector:card(args.incoming)+' button',text:'Cancel transfer'})
  await page.waitFor(card(args.incoming)+'[data-transfer-state="cancelled"]')
  await page.screenshot('org-inbox-cancelled')
  await page.press('Escape')
  await page.waitFor('[data-first-use-agent="rhea"]')
  await page.rightClick('[data-first-use-agent="rhea"]')
  await page.click({selector:'button.ctxmenu-item',text:'Focus'})
  await page.click('.cc-tabs [data-tab="inbox"]')
  await page.waitFor('.desk-tabpanel '+card(args.mine))
  const visible=await page.eval(()=>[...document.querySelectorAll('.desk-tabpanel .transfer-card')].map(n=>n.dataset.transferId))
  if(visible.includes(args.user)) throw Error('User-origin upload leaked into agent mail panel')
  await page.screenshot('agent-inbox-failed')
  await page.click({selector:'.desk-tabpanel '+card(args.mine)+' button',text:'Retry'})
  await page.waitFor('.desk-tabpanel '+card(args.mine)+'[data-transfer-state="failed"][data-transfer-attempt="2"]')
  await page.click({selector:'.desk-tabpanel '+card(args.mine)+' button',text:'Cancel transfer'})
  await page.waitFor('.desk-tabpanel '+card(args.mine)+'[data-transfer-state="cancelled"]')
  await page.click({selector:'.desk-tabpanel '+card(args.mine)+' button',text:'Remove file and send'})
  await page.waitFor('.desk-tabpanel '+card(args.mine)+'[data-transfer-state="removed"]')
  await page.screenshot('agent-inbox-removed')
  return {progress,visible,retryCancelRemove:true}
}
