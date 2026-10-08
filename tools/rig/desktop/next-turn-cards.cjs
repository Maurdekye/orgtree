module.exports=async(page,{args})=>{
 const card='[data-first-use-agent="rhea"]';
 await page.waitFor(card);
 await page.rightClick(card);
 await page.click({selector:'button.ctxmenu-item',text:'Focus'});
 await page.waitFor('.cc-head');
 await page.sleep(800);
 const read=()=>[...document.querySelectorAll('[data-next-turn]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({kind:e.dataset.nextTurn,text:e.textContent,title:e.title}));
 if(args.target) await page.waitFor(()=>!!document.querySelector('[data-next-turn="effort"]'));
 const check=async()=>{
  const badges=await page.eval(read);
  if(args.target){
   for(const [kind,next,from] of [['account',args.target,args.current],['model',args.model||'sol','luna'],['effort','high','medium']]){
    const b=badges.find(b=>b.kind===kind);
    if(!b||b.text!==`next turn \u2192 ${next}`||b.title!==`rhea's ${kind} will change from ${from} to ${next} next turn`)throw Error(JSON.stringify({kind,next,b,badges}));
   }
  }else if(badges.length)throw Error('unexpected pending '+JSON.stringify(badges));
  const current=await page.eval(()=>[...document.querySelectorAll('[data-serving-account]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.dataset.servingAccount));
  if(!current.includes(args.current))throw Error('current account missing '+JSON.stringify(current));
  if(args.target){
   const evidence=await page.eval(()=>({model:!!document.querySelector('.tier.t-luna'), effort:[...document.querySelectorAll('[data-effort-level]')].some(e=>e.dataset.effortLevel==='medium')}));
   if(!evidence.model||!evidence.effort)throw Error('current model/effort missing '+JSON.stringify(evidence));
  }
  return badges;
 };
 const header=await check();
 await page.screenshot(args.stage+'-header');
 // A couple of zoom steps leave the desk and reveal the world-scaled card.
 for(let i=0;i<8;i++){
  await page.click('button[title="zoom out"]');await page.sleep(350);
  if(await page.eval(()=>!!document.querySelector('[data-first-use-agent="rhea"] .sq-badges')))break;
 }
 await page.waitFor(card+' .sq-badges');
 const zoomCard=await check();
 await page.screenshot(args.stage+'-zoom-card');
 let pinned=null;
 if(args.stage==='queued'){
  await page.rightClick(card);
  await page.hover({selector:'button.ctxmenu-item',text:'^Open',regex:true});
  await page.click({selector:'button.ctxmenu-item',text:'Pin desk as a window'});
  await page.waitFor('.pinwin [data-next-turn]');
  pinned=await page.eval(()=>[...document.querySelectorAll('.pinwin [data-next-turn]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({kind:e.dataset.nextTurn,text:e.textContent,title:e.title})));
  if(pinned.length!==3)throw Error('pinned header must have one of each: '+JSON.stringify(pinned));
  await page.screenshot('queued-pinned-header');
 }
 return {header,zoomCard,pinned};
};
