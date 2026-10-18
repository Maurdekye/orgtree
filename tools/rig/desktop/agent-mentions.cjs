module.exports = async (page, {args}) => {
  const frames=async()=>{
    await page.eval(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    await page.sleep(60)
  }
  await page.waitFor('.quickchat-input')
  await page.click('.quickchat-input')
  await page.type('Ask @worker-')
  await frames();await page.screenshot('01-mention-hints')
  const hints=await page.eval(()=>!!document.querySelector('.agent-mentions'))
  if(args.baseline)return {hints}
  if(!hints)throw Error('agent mention hints missing')
  const projectHint=await page.eval(()=>!!document.querySelector('.agent-mentions .project-mark'))
  if(!projectHint)throw Error('project mention folder icon missing')
  await page.press('Tab')
  await frames();await page.screenshot('02-completed-mention')
  const text=await page.eval(()=>document.querySelector('.quickchat-input').value)
  if(text!=='Ask @worker-alpha ')throw Error('Tab did not insert the selected agent mention')
  return {hints,projectHint,text}
}
