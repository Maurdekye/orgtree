// Real renderer against the isolated PG engine: an app's file and media links
// belong to its running copy (USER 2026-10-26 mf7add4fda093). Hide (with play
// while hidden), pop-out and host-session renewal keep a remembered video
// playing, floating and popped out, and so does a Files change that grants
// access (Allow). Power off and Deny still end its ticket (206, then 403).
// The video is set the way an agent sets one: file_open on a scratch file,
// then state_patch {video: {id, name}} (user report 2026-10-26: the caption
// placement App's Play stopped working after such a video loaded).
// tools/rig/desktop/app-media-links.cjs drives the window. Every play seeks
// past what is buffered first, so it needs a fresh byte range from the engine.
//
// SILENT BY DEFAULT: the generated clip has no audio track (-an), every window
// is muted and the app's <video> is muted (a toned clip played from Session 0
// reached the user's headset, 2026-10-26). APP_MEDIA_FILE may name an existing
// silent MP4; otherwise ffmpeg on PATH makes a 300 s synthetic one.
// Build first with tools/rig/app-background-ui.mjs and pass its output folder in
// APP_BACKGROUND_BUILD. Session 0 only; fake CLIs; synthetic org only.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'

const built=process.env.APP_BACKGROUND_BUILD?path.resolve(process.env.APP_BACKGROUND_BUILD):''
export function setup(){
  if(!built||!fs.existsSync(path.join(built,'ui','index.html')))throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  return{ui:path.join(built,'ui'),fixture:{org:{name:'App media links'},agents:[{name:'boss',tier:'sol',grant:50,charter:'Synthetic app media links proof only.'}]}}
}
// The app half of the user's flow, nothing else: the remembered video loads
// through files.media at start, muted; Play toggles; errors show in #msg.
const PLAYER=`<style>html,body{margin:0;height:100%;background:#15171c;color:#d8dee9;font:13px system-ui}#video{display:block;width:100%;height:calc(100% - 40px);background:#000}p{margin:8px}</style>
<video id="video" muted playsinline preload="auto"></video><p><button id="bplay">Play</button> <span id="ttime">0.00</span> <span id="msg" hidden></span></p>
<script>
const video=document.getElementById('video'),msg=document.getElementById('msg');video.muted=true;video.defaultMuted=true
const show=t=>{msg.hidden=false;msg.textContent=t}
document.getElementById('bplay').addEventListener('click',()=>{if(video.paused){const p=video.play();if(p&&p.catch)p.catch(()=>{})}else video.pause()})
video.addEventListener('error',()=>show('Could not load the video'))
video.addEventListener('timeupdate',()=>{document.getElementById('ttime').textContent=video.currentTime.toFixed(2)})
;(async()=>{const s=await orgtree.state.get();if(s.video&&s.video.id){try{video.src=(await orgtree.files.media(s.video.id)).url}catch(e){show('Remembered video is unavailable: '+e.message)}}})()
</script>`

/** A silent synthetic MP4 long enough that each seek target is unbuffered. */
function silentClip(dir){
  if(process.env.APP_MEDIA_FILE)return path.resolve(process.env.APP_MEDIA_FILE)
  const clip=path.join(dir,'clip10.mp4'),file=path.join(dir,'synthetic-300s.mp4')
  const run=(args)=>{const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error('ffmpeg: '+(r.error?.message??r.stderr))}
  run(['-f','lavfi','-i','testsrc2=size=1280x720:rate=30','-t','10','-c:v','libx264','-preset','veryfast','-b:v','3000k','-g','60','-an','-movflags','+faststart',clip])
  run(['-stream_loop','29','-i',clip,'-c','copy','-an','-movflags','+faststart',file])
  return file
}
/** Engine wire lines for one apps route, with their local timestamps. */
function wire(log,route){
  const re=new RegExp(String.raw`\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+)\] \S+ \S+ user RESPONSE\s+\S+ (?:GET|POST) /api/orgs/[^/ ]+/apps/${route}\S* (\d{3})`,'g')
  return [...log.matchAll(re)].map(m=>({at:new Date(`${m[1]}T${m[2].slice(0,12)}`),status:Number(m[3])}))
}

export default async function(rig){
  const p=new Proof('app-media-links'),root='/api/orgs/'+rig.org
  const tool=async input=>{const r=await rig.tool('boss','orgtree_apps',input);assert(r.ok,r.text);return r.json}
  p.check("the rig serves this worktree's renderer build",path.resolve(rig.run.ui??'')===path.join(built,'ui'),{ui:rig.run.ui})
  const media=silentClip(p.dir)
  const probe=spawnSync('ffprobe',['-v','error','-select_streams','a','-show_entries','stream=index','-of','csv=p=0',media],{encoding:'utf8',windowsHide:true})
  if(!p.check('the clip is silent: no audio stream',probe.status===0&&probe.stdout.trim()==='',{media,audio:probe.stdout.trim(),error:probe.error?.message}))return p.summary()
  const app=await tool({action:'app_create',definition:{name:'Synthetic player',description:'Remembered video, the caption placement flow',html:PLAYER,initial_state:{},capabilities:['files.read'],width:900,height:560}})
  const panel=await rig.api('POST',root+'/apps',{action:'panel_open',app:app.id,new:true,label:'Synthetic captions'})
  const relative='boss/media/synthetic.mp4',target=path.join(rig.data,'scratch',rig.org,...relative.split('/'))
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(media,target)
  const opened=await tool({action:'file_open',panel:panel.id,root:'scratch',path:relative})
  const current=await rig.api('GET',`${root}/apps?request=${encodeURIComponent(JSON.stringify({action:'panel_get',panel:panel.id}))}`)
  await tool({action:'state_patch',panel:panel.id,expected_rev:current.rev,patch:{video:{id:opened.id,name:'synthetic.mp4'}}})
  p.note('the video is set as an agent sets it: file_open (no prompt) then state_patch',{opened:{bytes:opened.bytes,mime:opened.mime}})

  const t0=new Date()
  const run=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-media-links.cjs'),{preset:'1000x700',out:path.join(p.dir,'desktop'),timeout:420000,args:{panel:panel.id,app:app.id}})
  p.file('desktop-result.json',run)
  if(!p.check('the desktop script completed in Session 0, muted',run.ok&&run.value?.session?.sessionId===0&&run.value?.muted===true,{error:run.error,session:run.value?.session,muted:run.value?.muted,output:run.electronOutput?.slice(-800)}))return p.summary()
  const R=run.value,log=rig.engineLog(),since=r=>r.at>=new Date(t0.getTime()-1000)
  const lines={media:wire(log,'media').filter(since),bridge:wire(log,'bridge').filter(since)}
  const count=(list,ph)=>list.filter(r=>r.at>=new Date(ph.started)&&r.at<=new Date(new Date(ph.ended).getTime()+1500)).reduce((n,r)=>({...n,[r.status]:(n[r.status]??0)+1}),{})
  for(const ph of Object.values(R.phases))if(ph.started)ph.engine={media:count(lines.media,ph),bridge:count(lines.bridge,ph)}
  p.file('phases.json',R.phases)

  const plays=(ph,label)=>p.check(`${label}: the remembered video plays after a seek past its buffer`,
    !!ph&&!ph.error&&!ph.result?.error&&ph.result?.played>1,ph&&{played:ph.result?.played,error:ph.result?.error??ph.error,msg:ph.result?.msg,engine:ph.engine,shot:ph.shot})
  const hidden=(ph,label)=>p.check(`${label}: hidden media keeps playing`,
    !!ph?.setup?.whileHidden&&!ph.setup.whileHidden.error&&ph.setup.whileHidden.played>1&&ph.setup.hidden?.open===false,ph?.setup&&{whileHidden:ph.setup.whileHidden,hidden:ph.setup.hidden})
  const renewed=(ph,label)=>p.check(`${label}: the host really renewed its session (one more session_open), same document`,
    (ph?.engine?.bridge?.[200]??0)>=2&&!!ph?.setup?.sameDocument,ph&&{bridge:ph.engine?.bridge,setup:ph.setup})
  for(const [where,label] of [['floating','floating'],['popped-out','popped out']]){
    plays(R.phases[where],label)
    hidden(R.phases[`${where}-hide-show`],label)
    p.check(`${label}: Show kept the same document`,!!R.phases[`${where}-hide-show`]?.setup?.sameDocument,R.phases[`${where}-hide-show`]?.setup)
    plays(R.phases[`${where}-hide-show`],`${label}, after Hide and Show`)
    renewed(R.phases[`${where}-renewal`],label)
    plays(R.phases[`${where}-renewal`],`${label}, after the host renewed its session`)
  }
  plays(R.phases['popped-out-grant'],'popped out, after a Files change that grants access (Allow)')
  const c=R.controls??{}
  p.check('CONTROL power off ends the ticket: 206 before, 403 after',c.beforePowerOff===206&&c.afterPowerOff===403,c)
  plays(R.phases.restarted,'restarted after power off (a fresh document)')
  p.check('CONTROL Deny ends the ticket: 206 before, 403 after',c.beforeDeny===206&&c.afterDeny===403,c)
  p.check('CONTROL after Deny, a seek past the buffer cannot play',!!R.phases['after-deny']&&!(R.phases['after-deny'].result?.played>1),R.phases['after-deny']?.result)
  p.check('clipboard untouched in every window',JSON.stringify(R.clipboard?.main)==='[]'&&(R.clipboard?.popout==='closed'||JSON.stringify(R.clipboard?.popout)==='[]'),R.clipboard)
  return p.summary()
}
