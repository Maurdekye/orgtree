// Real renderer against the isolated PG engine: background panels on screen
// and measured (tools/rig/desktop/app-background.cjs drives the window). Build
// first with tools/rig/app-background-ui.mjs and pass its output folder in
// APP_BACKGROUND_BUILD. Session 0 only; fake CLIs; synthetic org only.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'

const built=process.env.APP_BACKGROUND_BUILD?path.resolve(process.env.APP_BACKGROUND_BUILD):''
export function setup(){
  if(!built||!fs.existsSync(path.join(built,'ui','index.html'))||!fs.existsSync(path.join(built,'panel-runtime.cjs')))throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  return{ui:path.join(built,'ui'),fixture:{org:{name:'Background panels capture'},agents:[{name:'boss',tier:'sol',grant:50,charter:'Synthetic background panels capture only.'}]}}
}
// Counts timer ticks, animation frames and Dedicated Worker ticks, probes the
// network from the frame and the worker, and saves its counters every 2 s.
// state.busy_ms makes a 20 ms game tick spin that long: the timer-driven loop
// the docs recommend, since a hidden frame's animation frames may not run.
const TICKER=`<style>body{font:13px system-ui;margin:12px;color:#d8dee9;background:#1f2430}b{font-size:18px}</style>
<p>Timer <b id="t">0</b> · frames <b id="r">0</b> · worker <b id="w">0</b></p><p id="f">network: checking</p>
<script>
(async()=>{
  const s=await orgtree.state.get(),busy=Number(s.busy_ms)||0,probe=String(s.probe||''),boot=Math.random().toString(36).slice(2)
  let timer=0,raf=0,worker=0,workerFetch='pending',frameFetch='pending';const violations=[]
  const seen=v=>{if(!violations.includes(v)&&violations.length<8)violations.push(v)}
  document.addEventListener('securitypolicyviolation',e=>seen('frame '+e.effectiveDirective))
  setInterval(()=>{timer++},100)
  let tick=0;setInterval(()=>{tick++;if(busy){const end=performance.now()+busy;while(performance.now()<end){}}},20)
  const frame=()=>{raf++;requestAnimationFrame(frame)};requestAnimationFrame(frame)
  try{
    const src="let n=0;const v=[];self.addEventListener('securitypolicyviolation',e=>v.push('worker '+e.effectiveDirective));setInterval(()=>postMessage({n:++n,v}),100);fetch("+JSON.stringify(probe)+",{mode:'no-cors'}).then(()=>postMessage({fetch:'allowed'}),e=>postMessage({fetch:'blocked ('+e.name+')'}))"
    const w=new Worker(URL.createObjectURL(new Blob([src],{type:'text/javascript'})))
    w.onmessage=e=>{if(e.data.n)worker=e.data.n;if(e.data.fetch)workerFetch=e.data.fetch;for(const x of e.data.v||[])seen(x)}
    w.onerror=e=>{workerFetch='worker failed: '+(e.message||'error')}
  }catch(e){workerFetch='worker refused: '+e.name}
  fetch(probe,{mode:'no-cors'}).then(()=>{frameFetch='allowed'},e=>{frameFetch='blocked ('+e.name+')'})
  setInterval(()=>{document.getElementById('t').textContent=timer;document.getElementById('r').textContent=raf;document.getElementById('w').textContent=worker;document.getElementById('f').textContent='network: worker '+workerFetch+', frame '+frameFetch},250)
  setInterval(()=>{orgtree.state.patch({timer,tick,raf,worker,workerFetch,frameFetch,violations,boot,at:Date.now(),vis:document.visibilityState}).catch(()=>{})},2000)
})()
</script>`

export default async function(rig){
  const p=new Proof('app-background-visual'),root='/api/orgs/'+rig.org
  const apps=input=>rig.api('POST',root+'/apps',input)
  const tool=async input=>{const r=await rig.tool('boss','orgtree_apps',input);assert(r.ok,r.text);return r.json}
  p.check("the rig serves this worktree's renderer build",path.resolve(rig.run.ui??'')===path.join(built,'ui'),{ui:rig.run.ui})
  const probe=rig.url+'/'
  const app=await tool({action:'app_create',definition:{name:'Ticker',description:'Synthetic background loop',html:TICKER,initial_state:{busy_ms:0,probe},capabilities:[],width:380,height:200}})
  const visible=await apps({action:'panel_open',app:app.id,new:true,label:'Visible'})
  const hidden=await tool({action:'panel_start',panel:(await tool({action:'panel_open',app:app.id,new:true,label:'Hidden'})).id})
  const off=await tool({action:'panel_open',app:app.id,new:true,label:'Off'})
  const run=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-background.cjs'),{preset:'wide',out:path.join(p.dir,'desktop'),timeout:420000,
    args:{preset:'wide',sampler:path.join(built,'panel-runtime.cjs'),app:app.id,probe,copies:8,busyMs:1,visible:{id:visible.id,label:'Visible'},hidden:{id:hidden.id,label:'Hidden'},off:{id:off.id,label:'Off'}}})
  p.file('desktop-result.json',run)
  if(!p.check('the capture script completed in Session 0',run.ok&&run.value?.session?.sessionId===0,{error:run.error,session:run.value?.session,output:run.electronOutput?.slice(-600)}))return p.summary()
  const R=run.value,row=label=>R.rows.find(r=>r.aria?.startsWith(label+','))
  const near=(a,b,limit)=>Math.abs(a-b)<=limit
  p.check('clipboard isolated in both windows: every page clipboard path refused and none used',R.installed.clipboardStub&&R.clipboard.calls.length===0&&R.realWindow?.clipboardStub&&R.realWindow.clipboardCalls?.length===0,{rig:R.clipboard,real:{stub:R.realWindow?.clipboardStub,calls:R.realWindow?.clipboardCalls}})
  p.check('restart restore: the visible copy loads shown and the running hidden copy loads parked, the off copy not at all',R.restored.visible.mounted&&!R.restored.visible.parked&&R.restored.hidden.mounted&&R.restored.hidden.parked===true&&!R.restored.off.mounted,R.restored)
  for(const key of ['centered','canvas'])p.check(`header Hide and Power off are on screen with nonzero size (${key})`,['hide','power'].every(k=>R.bounds[key]?.[k]?.onScreen)&&R.bounds[key].hide.title!==R.bounds[key].power.title,R.bounds[key])
  p.check('Hide parks the same runtime and keeps it running',R.hidden.parked===true&&R.hidden.runtime===R.hidden.shownRuntime&&R.hidden.saved.open===false&&R.hidden.saved.running===true,R.hidden)
  const {visible:rv,hidden:rh}=R.rates
  p.check('hidden timers and Dedicated Worker keep their visible rate in the same boot',rv.boot===rh.boot&&rh.sameBoot&&rh.timer>=0.8*rv.timer&&rh.worker>=0.8*rv.worker&&rh.worker>0,{visible:rv,hidden:rh})
  p.note('offscreen rig window: frames run only when the page paints, so parked frames there are not a frame-rate measure',{visible:rv.raf,hidden:rh.raf})
  p.check('control: Chromium stops frames of display:none and offscreen sandboxed frames, not of a parked one',R.controls['display-none'].raf!==null&&R.controls['display-none'].raf<1&&R.controls.offscreen.raf<1&&R.controls.parked.raf>=0.8*R.controls.visible.raf&&R.controls.visible.raf>0,R.controls)
  p.check('worker and frame network stay blocked by the inherited CSP',/^blocked/.test(rh.workerFetch)&&/^blocked/.test(rh.frameFetch),{worker:rh.workerFetch,frame:rh.frameFetch,violations:rh.violations})
  p.check('Show reveals the same runtime and boot',R.reshown.parked===false&&R.reshown.runtime===R.hidden.runtime&&R.reshown.boot===rh.boot&&R.reshown.saved.open===true,R.reshown)
  const [v,h,o]=['Visible','Hidden','Off'].map(row)
  p.check('rows show three distinct lights with state tooltips and no state word',v?.dot==='custom-app-dot open'&&h?.dot==='custom-app-dot running'&&o?.dot?.trim()==='custom-app-dot'&&v.title==='Running · visible'&&h.title==='Running · hidden'&&o.title==='Off'&&new Set([v,h,o].map(r=>JSON.stringify(r.dotStyle))).size===3&&[v,h,o].every(r=>r.dotRect?.onScreen),{rows:R.rows})
  p.check('running rows carry Power off and sampled CPU; the off row carries neither',v?.power?.onScreen&&h?.power?.onScreen&&!o?.power&&/CPU/.test(v?.cpu??'')&&/CPU/.test(h?.cpu??'')&&!o?.cpu,{visible:[v?.cpu,v?.powerLabel],hidden:[h?.cpu,h?.powerLabel]})
  p.note('CPU per running copy from the shipping sampler',R.samples.threeStates)
  const menu=R.contextMenu.menu
  p.check('the saved-row context menu opens on screen at the pointer with Start running',menu?.onScreen&&menu.width>0&&menu.height>0&&near(menu.x,R.contextMenu.at.x,24)&&near(menu.y,R.contextMenu.at.y,24)&&R.contextMenu.items.includes('Start running'),R.contextMenu)
  p.check('Start running runs the copy hidden: loaded and parked, never shown',R.started.saved.running===true&&R.started.saved.open===false&&R.started.mounted&&R.started.parked===true,R.started)
  p.check('row Power off and header Power off stop the copy and remove its frame',R.rowPowerOff.saved.running===false&&R.rowPowerOff.frameGone&&R.headerPowerOff.saved.running===false&&R.headerPowerOff.saved.open===false&&R.headerPowerOff.frameGone,{row:R.rowPowerOff,header:R.headerPowerOff})
  const blobs=list=>list?.workers?.filter(u=>u.startsWith('blob:')).length??0
  const w0=blobs(R.workers.before),w1=blobs(R.workers.afterRowPowerOff),w2=blobs(R.workers.afterHeaderPowerOff)
  if(w0>0)p.check('Power off ends the copy\'s Dedicated Worker',w1===w0-1&&w2===w0-2,R.workers);else p.note('Dedicated Workers were not visible to CDP auto-attach; termination not observed',R.workers)
  p.check('the renderer reported its running host count to the desktop bridge',R.runtimeCounts.some(c=>c.count>0),R.runtimeCounts.slice(-6))
  for(const phase of R.phases.filter(x=>x.copies))p.check(`${phase.label}: every copy mounted and kept its timers`,phase.mounted===phase.copies&&phase.loops.every(l=>l.timer>=8),{mounted:phase.mounted,loops:phase.loops})
  const loop8=R.phases.find(x=>x.label==='game loop x8'),timer8=R.phases.find(x=>x.label==='timers x8'),cpuOf=x=>x?.samples?.map(s=>s.cpu_percent)??[]
  p.check('a real window in Session 0 hosts the measured copies, all parked',R.realWindow?.booted&&R.phases.filter(x=>x.copies).every(x=>x.parked===true),{window:R.realWindow,parked:R.phases.map(x=>[x.label,x.parked])})
  const shownPhases=R.phases.filter(x=>x.copies&&!/window hidden/.test(x.label)),hiddenPhase=R.phases.find(x=>/window hidden/.test(x.label))
  p.check('in a shown real window parked copies keep their timers, game ticks and workers at full rate',R.realWindow?.visibility==='visible'&&shownPhases.length===4&&shownPhases.every(x=>x.loops.every(l=>l.timer>=8&&l.tick>=40&&l.worker>=8)),shownPhases.map(x=>[x.label,x.loops.map(l=>[l.timer,l.tick,l.worker])]))
  p.check('with the real window hidden like the tray, parked copies keep their timers, game ticks and workers',hiddenPhase?.loops?.length===8&&hiddenPhase.loops.every(l=>l.timer>=8&&l.tick>=40&&l.worker>=8),{visibility:R.realWindow?.hiddenVisibility,loops:hiddenPhase?.loops?.map(l=>[l.timer,l.tick,l.raf,l.worker])})
  p.note('animation frames of parked copies: they run only when the window repaints (shown window), none while hidden',{shown:shownPhases.map(x=>[x.label,x.loops.map(l=>l.raf)]),hidden:hiddenPhase?.loops?.map(l=>l.raf)})
  p.check('the shipping sampler attributes CPU to each running copy (sampled CPU), game loops above timers',loop8?.samples?.length===8&&loop8.samples.every(s=>s.method==='sampled CPU'&&s.cpu_percent>0)&&Math.min(...cpuOf(loop8))>Math.max(...cpuOf(timer8)),{loops:cpuOf(loop8),timers:cpuOf(timer8),methods:[...new Set([...(loop8?.samples??[]),...(timer8?.samples??[])].map(s=>s.method))]})
  p.check('without its own CDP client the sampler reports the hosting processes, labelled shared',loop8?.shared?.length===8&&loop8.shared.every(s=>s.method==='shared process CPU'&&s.cpu_percent>0&&s.cpu_percent===loop8.shared[0].cpu_percent),loop8?.shared?.slice(0,2))
  const tray=R.native.shownThenHidden
  p.check('a window hidden like the tray keeps its timers unthrottled once switched like a hosting window',tray?.hiddenUnthrottled?.timer>=50,R.native)
  p.file('measurements.json',{phases:R.phases.map(({label,copies,mounted,total,samples,shared,loops,processes})=>({label,copies,mounted,total,samples,shared,loops,processes})),native:R.native,controls:R.controls,rates:R.rates})
  p.note('memory and CPU by phase (CPU: 100 = one core)',R.phases.map(x=>({label:x.label,cpuOneCore:x.total.cpuOneCore,privateMB:x.total.privateMB,workingSetMB:x.total.workingSetMB,panelProcess:x.processes.filter(m=>m.role==='panel frames').map(m=>({cpuOneCore:m.cpuOneCore,privateMB:m.privateMB})),perCopy:cpuOf(x),shared:x.shared?.[0]?.cpu_percent??null})))
  p.note('hidden native windows: throttled, then switched like a hosting window',R.native)
  for(const shot of run.shots??[])p.note('screenshot '+shot.name,{file:shot.file,how:shot.how,size:[shot.width,shot.height]})
  return p.summary()
}
