// Actual renderer regression: equal 24px heights; every button except effort
// is square. Effort grows wide enough to show its full chosen/queued label.
module.exports=async function verifyComposerButtons(js){
 await js(`document.querySelector('[data-buttons="project broadcast"] .cc-broadcast-toggle').click()`);
 const paint=()=>js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 await paint();
 const measure=()=>js(`Array.from(document.querySelectorAll('[data-buttons]')).map(s=>{
  const box=s.querySelector('.cc-composer'),buttons=Array.from(box.querySelectorAll('button')).filter(b=>!b.closest('.eff-pop,.mention-menu')),
  urgent=box.querySelector('.cc-urgent-toggle'),fast=box.querySelector('.cc-fast');
  return {state:s.dataset.buttons,buttons:buttons.map(b=>{const r=b.getBoundingClientRect();return {kind:b.className,width:r.width,height:r.height,bottom:r.bottom}}),
  effort:Array.from(box.querySelectorAll('.cc-eff')).map(b=>{const label=b.querySelector('.cc-eff-label'),r=b.getBoundingClientRect(),range=document.createRange();
    range.selectNodeContents(label);const text=range.getBoundingClientRect(),style=getComputedStyle(b);
    return {value:label.textContent,width:r.width,height:r.height,textWidth:text.width,clientWidth:label.clientWidth,scrollWidth:label.scrollWidth,
    queued:b.classList.contains('queued-change'),fits:label.scrollWidth<=label.clientWidth&&getComputedStyle(label).textOverflow!=='ellipsis'
      &&text.left>=r.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft)-.5
      &&text.right<=r.right-parseFloat(style.borderRightWidth)-parseFloat(style.paddingRight)+.5};}),
  urgentBeforeFast:!fast||urgent.getBoundingClientRect().right<=fast.getBoundingClientRect().left,
  armed:urgent?.getAttribute('aria-pressed')==='true'};
 })`);
 const initial=await measure();
 await js(`document.querySelectorAll('.cc-urgent-toggle').forEach(b=>b.click())`);
 await paint();
 const levels=[];
 for(const level of ['low','medium','high','xhigh','max']){
  await js(`window.setComposerEffort(${JSON.stringify(level)})`);await paint();
  const rows=await measure();
  if(rows.flatMap(r=>r.effort).length!==2||rows.some(r=>r.effort.some(e=>e.value!==level))
    ||!rows.find(r=>r.state==='queued effort / interrupt')?.effort[0]?.queued)throw Error('missing chosen/queued effort '+level);
  levels.push({level,rows});
 }
 await js(`window.setComposerEffort('xhigh')`);await paint();const armed=await measure();
 const all=[...initial,...armed,...levels.flatMap(l=>l.rows)],height=all.every(r=>r.buttons.every(b=>b.height===24)),
 square=all.every(r=>r.buttons.every(b=>b.kind.split(' ').includes('cc-eff')||b.width===24)),order=all.every(r=>r.urgentBeforeFast),
 fullLabels=all.every(r=>r.effort.every(e=>e.fits));
 if(initial.length!==3||initial.some(r=>r.buttons.length<(r.state==='project broadcast'?5:6)))throw Error('missing actual composer controls');
 if(all.some(r=>r.buttons.some(b=>b.bottom>700)))throw Error('controls outside capture '+JSON.stringify(all));
 if(!height||!square||!order)throw Error('composer geometry changed '+JSON.stringify({height,square,order}));
 if(!armed.every(r=>r.armed)||initial.some(r=>r.armed))throw Error('urgent toggle changed behavior');
 return {height,square,order,fullLabels,initial,armed,levels};
};
