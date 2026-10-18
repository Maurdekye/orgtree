module.exports=async page=>{
 await page.resize('1000x700');await page.goto('/')
 await page.waitFor('[role="dialog"]')
 await page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,150))})
 const value=await page.eval(()=>{
  const box=document.querySelector('[role="dialog"]'),body=box.querySelector('.confirm-body')
  return {text:body.textContent,bodyHeight:body.clientHeight,scrollHeight:body.scrollHeight,
   buttons:[...box.querySelectorAll('.row > button')].map(b=>b.textContent)}
 })
 if(!value.text.includes('codex-9')||!value.text.includes('busy-5')||!value.buttons.includes('compact 3 agents'))throw new Error('Before fixture incomplete '+JSON.stringify(value))
 await page.screenshot('bulk-summary-before')
 return value
}
