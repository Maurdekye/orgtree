const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {app,BrowserWindow,dialog}=require('electron')
const root=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT),target=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP)
app.setPath('userData',path.join(root,'profile'));app.setAppPath(target)
let ready,child,started=false,finished=false
const checks=[],screenshots=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),spawn=cp.spawn
cp.spawn=function(command,args,options){if(args?.some(a=>String(a).endsWith('launch.py'))){assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')));args=[path.join(__dirname,'unstick_engine.py'),...args.slice(1)]}const c=spawn.call(this,command,args,options);child=c;let buffer='';c.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const r=JSON.parse(line);if(r.type==='ready')ready=r}catch{}}});c.stderr?.on('data',b=>fs.appendFileSync(path.join(root,'private-engine.log'),b));return c}
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)checks.push({name:'unstick-flow',status:'FAIL',reason:error.message});fs.writeFileSync(path.join(root,'unstick.json'),JSON.stringify({status:error?'FAIL':'PASS',checks,screenshots,childPids:child?[child.pid]:[],limits:['Synthetic locked agents/scoped actors; no provider turn','Actual operator UI and scoped agent release routes; send_message admission recorder only']},null,2));app.quit()}
const deadline=setTimeout(()=>finish(Error('Unstick deadline')),85000)
dialog.showMessageBox=async(...args)=>{if(args.at(-1).type==='error')finish(Error('Native error dialog'));return{response:0}}
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{
  const evaluate=code=>main.webContents.executeJavaScript(code,true)
  async function wait(code){for(let i=0;i<100;i++){if(await evaluate(`Promise.resolve(${code}).then(Boolean)`))return;await pause(100)}throw Error('Missing expected artifact control: '+code)}
  async function click(code){assert.equal(await evaluate(`(()=>{const b=${code};if(!b||b.disabled)return false;b.click();return true})()`),true,code)}
  async function capture(w,name){await pause(400);const file=path.join(root,name+'.png');try{const shot=await w.webContents.capturePage();assert.ok(!shot.isEmpty());fs.writeFileSync(file,shot.toPNG())}catch(error){if(error.message!=='UnknownVizError')throw error;const d=w.webContents.debugger;d.attach('1.3');try{const shot=await d.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:false});assert.ok(shot.data.length>100);fs.writeFileSync(file,Buffer.from(shot.data,'base64'))}finally{d.detach()}}screenshots.push(file)}
  try{
    assert.ok(ready&&ready.port!==7360);assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    const origin=new URL(main.webContents.getURL()).origin,tokens=JSON.parse(fs.readFileSync(path.join(root,'private-unstick-tokens.json'),'utf8'))
    async function release(actor,node){const r=await fetch(origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Orgtree-Agent-Token':tokens[actor]},body:JSON.stringify({org:'acceptance-runtime',node:actor,tool:'orgtree_unstick',args:{node}})});return{status:r.status,body:await r.json()}}
    const self=await release('builder','builder'),peer=await release('builder','reviewer')
    assert.equal(self.status,422);assert.equal(peer.status,422)
    assert.equal(fs.existsSync(path.join(root,'unstick-admissions.jsonl')),false)
    checks.push({name:'scoped-self-and-peer-unstick-refused-no-admission',status:'PASS'})
    await wait('document.querySelector(".org")');await click('document.querySelector(".org")')
    await wait(`[...document.querySelectorAll('.sq .name')].some(e=>e.textContent==='builder')`)
    await evaluate(`(()=>{const c=[...document.querySelectorAll('.sq')].find(e=>e.querySelector('.name')?.textContent==='builder'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+25,clientY:r.y+25}));return true})()`)
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Open desk')`)
    await wait(`document.querySelector('.desk-body button.unstick')`)
    await capture(main,'frozen-builder-before-unstick')
    await click(`document.querySelector('.desk-body button.unstick')`)
    await wait(`!document.querySelector('.desk-body button.unstick')`)
    const one=fs.readFileSync(path.join(root,'unstick-admissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(one,[{node:'builder',text:'Retained work for builder',view:'Original view for builder',sender:null}])
    await capture(main,'user-unstick-after')
    const supervised=await release('planner','reviewer');assert.equal(supervised.status,200)
    assert.ok(supervised.body.released.includes('frozen'));assert.ok(supervised.body.released.includes('limit_locked'))
    assert.ok(supervised.body.released.some(r=>r.startsWith('fable_lock')))
    const records=fs.readFileSync(path.join(root,'unstick-admissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(records.length,2);assert.deepEqual(records[1],{node:'reviewer',text:'Retained work for reviewer',view:'Original view for reviewer',sender:'planner'})
    const again=await release('planner','reviewer');assert.equal(again.status,200);assert.deepEqual(again.body.released,[])
    assert.equal(fs.readFileSync(path.join(root,'unstick-admissions.jsonl'),'utf8').trim().split('\n').length,2)
    checks.push({name:'actual-user-ui-and-supervisor-scoped-unstick-retained-replay-once',status:'PASS',admissions:records,workerExecution:false})
    finish()
  }catch(error){fs.writeFileSync(path.join(root,'artifact-error-dom.txt'),await evaluate('document.body.innerText').catch(()=>''));await capture(main,'artifact-error').catch(()=>{});finish(error)}
})})
require(path.join(target,'dist/main/index.cjs'))
