const fs = require('node:fs');
const path = require('node:path');
module.exports=async(page,{args,out})=>{
 const checks=[];
 const assert=(what,ok,detail)=>{
  checks.push({what,ok:!!ok,detail});
  fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(checks,null,2));
  if(!ok)throw Error(what+': '+JSON.stringify(detail));
 };
 const capture=async(name)=>{
  await page.eval(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot(name);
 };
 const card='[data-first-use-agent="rhea"]';
 await page.waitFor(card);
 await page.rightClick(card);
 await page.click({selector:'button.ctxmenu-item',text:'Focus'});
 await page.waitFor('.cc-head');
 await page.sleep(800);
 const read=()=>[...document.querySelectorAll('[data-next-turn]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({kind:e.dataset.nextTurn,text:e.textContent,title:e.title}));
 if(args.target) await page.waitFor(()=>!!document.querySelector('[data-next-turn="effort"]'));
 const check=async(surface)=>{
  const badges=await page.eval(read);
  if(args.target){
   for(const [kind,next,from] of [['account',args.target,args.current],['model',args.model||'sol','luna'],['effort','high','medium']]){
    const b=badges.find(b=>b.kind===kind);
    assert(`${surface}: ${kind} has exact colon label and current-to-target tooltip`,
     !!b&&b.text===`next turn: ${next}`&&b.title===`rhea's ${kind} will change from ${from} to ${next} next turn`,{kind,next,b,badges});
   }
  }else assert(`${surface}: no pending badges`,badges.length===0,badges);
  const current=await page.eval(()=>[...document.querySelectorAll('[data-serving-account]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.dataset.servingAccount));
  assert(`${surface}: serving account remains current`,current.includes(args.current),current);
  if(args.target){
   const evidence=await page.eval(()=>({model:!!document.querySelector('.tier.t-luna'), effort:[...document.querySelectorAll('[data-effort-level]')].some(e=>e.dataset.effortLevel==='medium')}));
   assert(`${surface}: serving model and effort remain current`,evidence.model&&evidence.effort,evidence);
   const misplaced=await page.eval(()=>[...document.querySelectorAll('[data-next-turn="model"]')]
    .filter(e=>e.getBoundingClientRect().width>0&&!e.closest('.cc-head-meta, .sq-badges')).length);
   assert(`${surface}: queued model stays in the badge row`,misplaced===0,misplaced);
  }
  return badges;
 };
 const header=await check('header');
 await capture(args.stage+'-header');
 // A couple of zoom steps leave the desk and reveal the world-scaled card.
 for(let i=0;i<8;i++){
  await page.click('button[title="zoom out"]');await page.sleep(350);
  if(await page.eval(()=>!!document.querySelector('[data-first-use-agent="rhea"] .sq-badges')))break;
 }
 await page.waitFor(card+' .sq-badges');
 const zoomCard=await check('zoom card');
 const overflow=await page.eval(()=>{
  const card=document.querySelector('[data-first-use-agent="rhea"]');
  const bounds=card.getBoundingClientRect();
  return [...card.querySelectorAll('[data-next-turn], .sq-badges .badge, .sq-title .name')]
   .filter(e=>{const r=e.getBoundingClientRect();return r.right>bounds.right+1||r.bottom>bounds.bottom+1;})
   .map(e=>e.textContent);
 });
 assert('zoom card: badges and agent name fit inside card bounds',overflow.length===0,overflow);
 await capture(args.stage+'-zoom-card');
 let pinned=null;
 if(args.stage==='queued'){
  await page.rightClick(card);
  await page.hover({selector:'button.ctxmenu-item',text:'^Open',regex:true});
  await page.click({selector:'button.ctxmenu-item',text:'Desk as a pinned window'});
  await page.waitFor('.pinwin [data-next-turn]');
  pinned=await page.eval(()=>[...document.querySelectorAll('.pinwin [data-next-turn]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({kind:e.dataset.nextTurn,text:e.textContent,title:e.title})));
  assert('pinned header: exactly one account, model and effort card',pinned.length===3&&
   ['account','model','effort'].every(kind=>pinned.filter(b=>b.kind===kind).length===1),pinned);
  assert('pinned header: queued model stays in the badge row',
   await page.eval(()=>!!document.querySelector('.pinwin .cc-head-meta [data-next-turn="model"]')));
  await capture('queued-pinned-header');
 }
 return {header,zoomCard,pinned,checks};
};
