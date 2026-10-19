// Actual renderer regression: every visible message-box control has the same
// border-box size as its notice toggle, in normal and armed/queued states.
module.exports=async function verifyComposerButtons(js,phase){
 await js(`(()=>{const s=document.querySelector('[data-buttons="project broadcast"]');s.querySelector('.cc-broadcast-toggle').click()})()`);
 await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const measure=()=>js(`Array.from(document.querySelectorAll('[data-buttons]')).map(s=>{
  const box=s.querySelector('.cc-composer'),buttons=Array.from(box.querySelectorAll('button')).filter(b=>!b.closest('.eff-pop,.mention-menu')),
  urgent=box.querySelector('.cc-urgent-toggle'),fast=box.querySelector('.cc-fast');
  return {state:s.dataset.buttons,buttons:buttons.map(b=>{const r=b.getBoundingClientRect();return {kind:b.className,width:r.width,height:r.height,bottom:r.bottom}}),
  urgentBeforeFast:!fast||urgent.getBoundingClientRect().right<=fast.getBoundingClientRect().left,
  armed:urgent?.getAttribute('aria-pressed')==='true'};
 })`);
 const initial=await measure();
 await js(`document.querySelectorAll('.cc-urgent-toggle').forEach(b=>b.click())`);
 await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const armed=await measure();
 if(initial.length!==3||initial.some(r=>r.buttons.length<(r.state==='project broadcast'?5:6)))throw Error('missing actual composer controls '+JSON.stringify(initial));
 const all=[...initial,...armed],equal=all.every(r=>r.buttons.every(b=>b.width===24&&b.height===24)),order=all.every(r=>r.urgentBeforeFast);
 if(all.some(r=>r.buttons.some(b=>b.bottom>700)))throw Error('controls outside capture');
 if(phase==='green'?!equal||!order:equal||order)throw Error('unexpected control regression '+JSON.stringify({equal,order,all}));
 if(!armed.every(r=>r.armed)||initial.some(r=>r.armed))throw Error('urgent toggle changed behavior');
 return {equal,order,initial,armed};
};
