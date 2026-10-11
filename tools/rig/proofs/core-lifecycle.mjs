// Real isolated host/engine/helper, production desktop controller without UI.
// C: holds only disposable trusted state; binaries, scripts and evidence stay D:.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {spawn, spawnSync} from 'node:child_process'
import {build} from 'esbuild'
import {cleanEnv, stopRun, writeRun, alive} from '../lib.mjs'
import {Proof} from '../proof.mjs'
import {sessionLauncher, q} from './credential-broker.mjs'

export async function setup() { return {name:'core-lifecycle', fixture:'none'} }
export default async function(rig) {
  const p = new Proof('core-lifecycle')
  const root = process.env.ORGTREE_CORE_RIG_STATE
  const allowed = path.join(os.homedir(), 'AppData', 'Local', 'orgtree-rig-core-agy')
  if (!root || path.resolve(root).toLowerCase() !== allowed.toLowerCase()) throw Error('exact authorized isolated state root required')
  if (fs.existsSync(root)) throw Error('state root already exists; inspect before reuse')
  const run = rig.refresh()
  writeRun(rig.dir, {busy:new Date().toISOString()})
  await stopRun(rig.dir, {keep:true})
  fs.cpSync(rig.data, root, {recursive:true})
  const engine = path.join(rig.dir,'bin','orgtree-engine.exe')
  const broker = path.join(rig.dir,'bin','orgtree-credential-broker.exe')
  fs.copyFileSync(process.env.ORGTREE_RIG_BROKER, broker)
  const desktopScript = path.join(p.dir,'core-desktop.cjs')
  await build({entryPoints:['tools/rig/core-desktop.ts'],bundle:true,platform:'node',format:'cjs',outfile:desktopScript,logLevel:'silent'})
  const launcher = sessionLauncher(rig.dir, `OrgtreeRigProof-core-${path.basename(rig.dir)}`)
  const state = () => JSON.parse(fs.readFileSync(path.join(root,'core-lifecycle.json'),'utf8'))
  const descriptor = () => JSON.parse(fs.readFileSync(path.join(root,'engine-attach.json'),'utf8'))
  const env = {...cleanEnv(), ORGTREE_V2_DATA:root, ORGTREE_V2_UI_DIR:run.ui,
    ORGTREE_P03_PG_BIN:run.pgBin, ORGTREE_ENGINE_SAFE_START:'1',ORGTREE_ENGINE_RIG:'1',
    ORGTREE_ENGINE_ALLOW_INITDB:'1', ORGTREE_NET_OFFLINE:'1',
    ORGTREE_CLAUDE_BIN:path.join(rig.dir,'bin','claude.exe'),ORGTREE_CODEX_BIN:path.join(rig.dir,'bin','codex.exe'),
    ORGTREE_AGY_BIN:path.join(rig.dir,'bin','agy.exe'), ORGTREE_TAILSCALE_BIN:path.join(rig.dir,'bin','tailscale.cmd'),
    ORGTREE_FAKECLI_DIR:rig.fakeDir,ORGTREE_FAKECLI_HOME:path.join(root,'rig-home')}
  let host, hostExit, deskPid=0, helperPid=0, enginePid=0, desktopResult=''
  const launchHost = delay => {
    host = spawn(engine,['host'],{env:{...env,ORGTREE_RIG_CORE_STARTUP_DELAY_MS:String(delay)},windowsHide:true,stdio:['ignore','ignore','pipe']})
    host.stderr.on('data', c => fs.appendFileSync(path.join(p.dir,'host.log'),c))
    hostExit = new Promise(resolve=>host.once('exit',code=>resolve(code)))
  }
  const kill = pid => { if (pid && alive(pid)) process.kill(pid) }
  async function begin(label, {delay=0, helper=true}={}) {
    const b=spawnSync(engine,['core-control','begin',root],{windowsHide:true,encoding:'utf8'})
    if(b.status!==0)throw Error('old cohort not stopped: '+b.stderr)
    launchHost(delay)
    enginePid=(await rig.waitFor(()=>{const s=state();return s.host?.pid===host.pid?s:null},{what:label+' startup journal'})).engine.pid
    const result=path.join(p.dir,label+'-desktop.json')
    desktopResult=result
    const config=path.join(p.dir,label+'-config.json')
    fs.writeFileSync(config,JSON.stringify({root,engine,result}))
    await launcher.start({},`"${process.execPath}" "${desktopScript}" "${config}"`)
    deskPid=(await rig.waitFor(()=>JSON.parse(fs.readFileSync(result,'utf8')),{what:'desktop controller'})).pid
    if(helper) {
      await launcher.start({ORGTREE_V2_DATA:root},`"${broker}"`)
      // Only this unique copied executable belongs to this proof.
      const {ps}=await import('./credential-broker.mjs')
      helperPid=Number(ps(`(Get-Process orgtree-credential-broker -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq ${q(broker)}}).Id`))
      if(!helperPid)throw Error('helper did not start')
    }
    return result
  }
  async function ready(label, helper=true) {
    return await rig.waitFor(()=>{const s=state();const a=descriptor();return a.enginePid===enginePid&&s.desktop?.pid===deskPid&&(!helper||s.helper?.pid===helperPid)?s:null},{what:label+' registered cohort',timeout:180000})
  }
  async function stopped(label, timeout=90000) {
    await rig.waitFor(()=>![host?.pid,enginePid,deskPid,helperPid].some(pid=>pid&&alive(pid)),{what:label+' complete stop',timeout})
    p.check(label+': every core process stopped',true)
    const s=state()
    p.check(label+': durable generation stop exists',fs.existsSync(path.join(root,`core-stop-${s.generation}.json`)))
    const retry=spawnSync(engine,['host'],{env,windowsHide:true,timeout:15000,encoding:'utf8'})
    p.check(label+': task retry exits successfully without recreating engine',retry.status===0&&!alive(enginePid),{exit:retry.status})
    helperPid=deskPid=enginePid=0
  }
  async function action(action) {
    const id=Date.now()
    fs.writeFileSync(desktopResult+'.command',JSON.stringify({id,action}))
    return await rig.waitFor(()=>{const r=JSON.parse(fs.readFileSync(desktopResult+'.reply','utf8'));return r.id===id?r:null},{what:'desktop '+action,timeout:15000})
  }
  try {
    if(process.env.ORGTREE_CORE_RIG_PHASE!=='transitions') {
    for (const role of ['desktop','helper','engine','host']) {
      await begin(role);await ready(role)
      p.check(role+': all authenticated stamped members registered',true)
      const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'})
      await new Promise(resolve=>child.once('exit',resolve))
      p.check(role+': unrelated child exit leaves cohort alive',[host.pid,enginePid,deskPid,helperPid].every(alive))
      kill({desktop:deskPid,helper:helperPid,engine:enginePid,host:host.pid}[role])
      await stopped(role)
    }
    await begin('pre-ready',{delay:30000})
    p.check('pre-ready: control descriptor absent or belongs to old engine',!fs.existsSync(path.join(root,'engine-attach.json'))||descriptor().enginePid!==enginePid)
    kill(host.pid)
    await stopped('pre-ready')
    await begin('slow-conversion',{delay:130000})
    const started=Date.now()
    await ready('slow-conversion')
    p.check('slow-conversion: startup longer than missing-member grace stays alive',Date.now()-started>120000&&[host.pid,enginePid,deskPid,helperPid].every(alive))
    kill(deskPid);await stopped('slow-conversion')
    await begin('missing-helper',{helper:false});await ready('missing-helper',false)
    const start=Date.now();await stopped('missing-helper',150000)
    p.check('missing-helper: grace is bounded',Date.now()-start>=110000&&Date.now()-start<150000)
    } else {
      await begin('restart');await ready('restart')
      p.check('restart: authenticated transition accepted',(await action('transition')).ok)
      const until=state().transition_until
      p.check('restart: a second transition cannot extend deadline',!(await action('transition')).ok&&state().transition_until===until)
      const a=descriptor()
      await fetch(`http://127.0.0.1:${a.port}/api/desktop/shutdown`,{method:'POST',headers:{'X-Orgtree-Desktop-Token':a.token}})
      await rig.waitFor(()=>!alive(enginePid)&&!alive(host.pid),{what:'deliberate old engine stop'})
      p.check('restart: desktop and helper survive deliberate engine stop',[deskPid,helperPid].every(alive))
      launchHost(0)
      enginePid=(await rig.waitFor(()=>{const s=state();return s.host?.pid===host.pid?s:null},{what:'replacement engine journal'})).engine.pid
      await ready('restart')
      p.check('restart: completion clears inherited allowance',(await action('complete')).ok&&state().transition_until===0)
      kill(deskPid);await stopped('restart')
      await begin('transition-timeout');await ready('transition-timeout')
      p.check('timeout: authenticated transition accepted',(await action('transition')).ok)
      const began=Date.now()
      await stopped('transition-timeout',210000)
      p.check('timeout: bounded allowance ends even with all processes alive',Date.now()-began>=175000&&Date.now()-began<210000)
    }
    return p.summary()
  } finally {
    // Normal authenticated shutdown first; forced cleanup only isolated subjects.
    try { const a=descriptor();await fetch(`http://127.0.0.1:${a.port}/api/desktop/shutdown`,{method:'POST',headers:{'X-Orgtree-Desktop-Token':a.token},signal:AbortSignal.timeout(5000)}) } catch {}
    await rig.waitFor(()=>!alive(enginePid),{timeout:15000,what:'rig teardown engine'}).catch(()=>{})
    for(const pid of [deskPid,helperPid,enginePid,host?.pid])kill(pid)
    p.check('temporary interactive task removed',launcher.remove())
    // Keep state until the caller validates the exact authorized path for cleanup.
    p.note('disposable trusted state for checked cleanup',{root})
    p.save()
    await rig.restart()
  }
}
