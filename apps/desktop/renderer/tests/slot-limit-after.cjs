module.exports=async page=>{
 await page.resize('1000x700')
 await page.waitFor('.project-slots-badge')
 const measured=await page.eval(()=>{
  const card=document.querySelector('.sq.project'),badge=card.querySelector('.project-slots-badge')
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),style=getComputedStyle(badge)
  ctx.font=style.font
  const widths=Array.from({length:10},(_,i)=>({digit:String(i),width:ctx.measureText(String(i)).width}))
  const widest=widths.reduce((a,b)=>a.width>=b.width?a:b).digit
  const results=[]
  for(let digits=1;digits<=12;digits++){
   const n=widest.repeat(digits)
   badge.textContent=n+'/'+n+' held'
   const range=document.createRange();range.selectNodeContents(badge)
   const text=range.getBoundingClientRect(),box=badge.getBoundingClientRect(),parent=card.getBoundingClientRect()
   // Ignore ellipsis/clipping: the full text must fit the badge's content box.
   const inset=(parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth))*3
   results.push({digits,text:badge.textContent,textWidth:text.width,badgeWidth:box.width,cardWidth:parent.width,fits:text.width<=box.width-inset+0.1&&box.right<=parent.right+0.1})
  }
  const digits=Math.max(...results.filter(r=>r.fits).map(r=>r.digits))
  const n=widest.repeat(digits);badge.textContent=n+'/'+n+' held'
  const note=document.createElement('p');note.style.cssText='position:fixed;bottom:30px;left:24px';note.textContent='Widest digit: '+widest+'; '+digits+' digits fit; '+(digits+1)+' overflow.';document.body.appendChild(note)
  return {widest,widths,font:style.font,scale:3,results,digits,capacity:10**Math.min(digits,9)-1}
 })
 await page.eval(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);await new Promise(r=>setTimeout(r,120))})
 await page.screenshot('slot-card-digit-limit')
 return measured
}
