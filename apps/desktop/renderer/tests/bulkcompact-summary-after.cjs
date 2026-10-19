module.exports=async page=>{
 await page.resize('1000x700');await page.goto('/')
 await page.waitFor('[data-compact-count="normal"]')
 await page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,150))})
 const value=await page.eval(()=>{
  const box=document.querySelector('[role="dialog"]'),body=box.querySelector('.confirm-body'),r=box.getBoundingClientRect()
  return {text:body.textContent,bodyHeight:body.clientHeight,scrollHeight:body.scrollHeight,dialog:r.toJSON(),
   buttons:[...box.querySelectorAll('.row > button')].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,visible:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth}}),
   counts:[...body.querySelectorAll('[data-compact-count]')].map(p=>({text:p.textContent,title:p.title})),
   skips:[...body.querySelectorAll('[data-compact-skip]')].map(p=>({text:p.textContent,title:p.title})),
   modes:[...body.querySelectorAll('[data-compact-preview]')].map(section=>({mode:section.dataset.compactPreview,
     skips:[...section.querySelectorAll('[data-compact-skip]')].map(p=>({key:p.dataset.compactSkip,title:p.title,text:p.textContent}))}))}
 })
 if(value.scrollHeight>value.bodyHeight+1||value.dialog.top<0||value.dialog.bottom>700
  ||value.buttons.some(b=>!b.visible)||value.counts.length!==2||value.skips.length!==6
  ||value.text.includes('codex-')||value.text.includes('busy-')
  ||value.counts[0].title.split(', ').length!==14||value.counts[1].title.split(', ').length!==3
  ||JSON.stringify(value.buttons.map(b=>b.text))!==JSON.stringify(['compact 3 agents','cheap-compact 14 agents','cancel']))
   throw new Error('Count-only dialog layout failed '+JSON.stringify(value))
 for(const mode of value.modes){
  for(const [key,prefix,count] of [['busy','busy',5],['empty','empty',9]]){
   const rows=mode.skips.filter(row=>row.key===key)
   if(rows.length!==1||rows[0].title!==Array.from({length:count},(_,i)=>prefix+'-'+(i+1)).join(', ')
    ||!rows[0].text.startsWith(count+' agents'))throw new Error('Mode exclusion hover data failed '+JSON.stringify(mode))
  }
 }
 await page.screenshot('bulk-skips-both-modes')
 return value
}
