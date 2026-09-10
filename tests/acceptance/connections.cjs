const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict')
const {app,dialog}=require('electron')
const root=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_ROOT),target=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_APP),exchange=fs.realpathSync.native(process.env.ORGTREE_ACCEPTANCE_EXCHANGE),role=process.env.ORGTREE_ACCEPTANCE_HUB_ROLE
assert.ok(['host','client'].includes(role));assert.ok(root.includes('orgtree-v2-acceptance-'));assert.ok(exchange.includes('v2-local-connections-'))
const slug=role+'-acceptance',other=role==='host'?'client':'host',checks=[],screenshots=[]
let ready,child,started=false,finished=false
app.setPath('userData',path.join(root,'profile'));app.setAppPath(target)
const spawn=cp.spawn,pause=ms=>new Promise(r=>setTimeout(r,ms)),write=(name,data)=>fs.writeFileSync(path.join(exchange,name),JSON.stringify(data))
cp.spawn=function(command,args,options){if(args?.some(a=>String(a).endsWith('launch.py'))){assert.equal(fs.realpathSync.native(options.env.ORGTREE_DATA),fs.realpathSync.native(path.join(root,'data')));args=[path.join(__dirname,'visual_engine.py'),...args.slice(1)]}const c=spawn.call(this,command,args,options);child=c;let buffer='';c.stdout?.on('data',b=>{buffer+=b;while(buffer.includes('\n')){const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const r=JSON.parse(line);if(r.type==='ready')ready=r}catch{}}});c.stderr?.on('data',b=>fs.appendFileSync(path.join(root,'private-engine.log'),b));return c}
function finish(error){if(finished)return;finished=true;clearTimeout(deadline);if(error)checks.push({name:'connections-flow',status:'FAIL',reason:error.message});fs.writeFileSync(path.join(root,'connections.json'),JSON.stringify({status:error?'FAIL':'PASS',checks,screenshots,enginePort:ready?.port,childPids:child?[child.pid]:[]},null,2));app.quit()}
const deadline=setTimeout(()=>finish(Error('Connections deadline')),90000)
dialog.showMessageBox=async(...args)=>{if(args.at(-1).type==='error')finish(Error('Native error dialog'));return{response:0}}
async function waitFile(name){for(let i=0;i<300;i++){if(fs.existsSync(path.join(exchange,name)))return JSON.parse(fs.readFileSync(path.join(exchange,name),'utf8'));await pause(150)}throw Error('Missing bounded exchange: '+name)}
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{
  const evaluate=code=>main.webContents.executeJavaScript(code,true)
  async function wait(code){for(let i=0;i<200;i++){if(await evaluate(`Promise.resolve(${code}).then(Boolean)`))return;await pause(150)}throw Error('Expected local Connections state did not appear')}
  async function click(code){assert.equal(await evaluate(`(()=>{const b=${code};if(!b||b.disabled)return false;b.click();return true})()`),true,'Missing enabled Connections control')}
  async function input(code,value){await evaluate(`(()=>{const i=${code};Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)}
  async function api(route,body){return evaluate(`fetch(${JSON.stringify(route)},${body?`{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}`:'{}'}).then(async r=>({status:r.status,body:await r.json()}))`)}
  async function capture(name){await pause(500);const shot=await main.webContents.capturePage();assert.ok(!shot.isEmpty());const file=path.join(root,name+'.png');fs.writeFileSync(file,shot.toPNG());screenshots.push(file)}
  try{
    assert.ok(ready&&ready.port!==7360);assert.equal(fs.realpathSync.native(ready.dataRootId),fs.realpathSync.native(path.join(root,'data')))
    await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('new organization'))`)
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('new organization'))`)
    await wait(`document.querySelector('input[placeholder="organization name"]')`)
    await input(`document.querySelector('input[placeholder="organization name"]')`,role+' acceptance')
    await evaluate(`document.querySelector('input[placeholder="organization name"]').form.requestSubmit();true`)
    await wait(`location.pathname==='/o/${slug}'`)
    await click(`document.querySelector('header button[aria-label="Settings"]')`)
    await wait(`document.querySelector('#org-settings-tab-connections')`)
    await click(`document.querySelector('#org-settings-tab-connections')`)
    await wait(`document.querySelector('.host-hub input[aria-label="Mail hub port"]')`)
    const own=(await api('/api/orgs/'+slug+'/net')).body;assert.ok(own.identity.slug);write(role+'-identity.json',{slug:own.identity.slug,enginePort:ready.port})
    const remote=await waitFile(other+'-identity.json');assert.notEqual(remote.enginePort,ready.port)
    if(role==='host'){
      await input(`document.querySelector('input[aria-label="Mail hub port"]')`,'0')
      await input(`document.querySelector('input[aria-label="Advertised mail hub host"]')`,'127.0.0.1')
      if(!await evaluate(`document.querySelector('input[aria-label="Enable mail hub"]').checked`))await click(`document.querySelector('input[aria-label="Enable mail hub"]')`)
      assert.equal(await evaluate(`document.querySelector('select[aria-label="Mail hub listen address"]').value`),'127.0.0.1')
      await click(`[...document.querySelectorAll('.host-hub button')].find(b=>b.textContent==='Save hosting settings')`)
      await wait(`document.querySelector('.host-hub').textContent.includes('Hosting settings saved.')`)
      await evaluate(`document.querySelector('.connection-setup:not(.host-hub) details:last-child').open=true;true`)
      await input(`document.querySelectorAll('.connection-setup:not(.host-hub) details:last-child input')[0]`,'acceptance-client')
      await input(`document.querySelectorAll('.connection-setup:not(.host-hub) details:last-child input')[1]`,remote.slug)
      await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Create credential')`)
      await wait(`document.querySelector('textarea[aria-label="New connection credential"]')`)
      const invitation=JSON.parse(await evaluate(`document.querySelector('textarea[aria-label="New connection credential"]').value`));assert.equal(new URL(invitation.address).hostname,'127.0.0.1')
      write('private-invitation.json',invitation)
      await click(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Hide credential')`)
      await capture('host-configured');checks.push({name:'actual-host-config-and-scoped-credential-ui',status:'PASS'})
    }else{
      const invitation=await waitFile('private-invitation.json');assert.equal(new URL(invitation.address).hostname,'127.0.0.1')
      const denied=await api('/api/orgs/'+slug+'/net/pair',{address:invitation.address,peer_id:invitation.peer_id,peer_slug:invitation.peer_slug,peer_token:'deliberately-invalid-acceptance-token'})
      assert.equal(denied.status,502)
      assert.ok(!(await api('/api/orgs/'+slug+'/net')).body.hubs.some(h=>h.id===invitation.peer_id),'Failed credential must not add connection')
      checks.push({name:'forged-credential-refused-without-persisting-connection',status:'PASS'})
      for(const [index,value] of [invitation.address,invitation.peer_id,invitation.peer_slug,invitation.peer_token].entries())await input(`document.querySelectorAll('.connection-setup:not(.host-hub) form input')[${index}]`,value)
      await click(`document.querySelector('.connection-setup:not(.host-hub) form button[type="submit"]')`)
      await wait(`document.querySelector('.connection-setup:not(.host-hub) input[type="password"]').value===''`)
      const sanitized=(await api('/api/orgs/'+slug+'/net')).body;assert.ok(sanitized.hubs.some(h=>h.id===invitation.peer_id));assert.ok(!JSON.stringify(sanitized).includes(invitation.peer_token))
      await capture('client-connected');checks.push({name:'actual-connect-form-and-sanitized-status',status:'PASS'})
    }
    write(role+'-paired.json',true);await waitFile(other+'-paired.json')
    const expected=other==='client'?'Synthetic client to host.':'Synthetic host to client.'
    const send=async()=>{for(let i=0;i<100;i++){const r=await api('/api/orgs/'+slug+'/org_inbox/send',{to:'@net:'+remote.slug,body:role==='client'?'Synthetic client to host.':'Synthetic host to client.',attachments:[]});if(r.status===200){assert.ok(r.body.id);return}assert.equal(r.status,422);await pause(300)}throw Error('Local peer never became sendable')}
    if(role==='client')await send()
    await wait(`fetch('/api/orgs/${slug}/org_inbox').then(r=>r.json()).then(v=>v.entries.some(e=>e.body===${JSON.stringify(expected)}&&e.dir==='in'))`)
    const inbox=(await api('/api/orgs/'+slug+'/org_inbox')).body
    const received=inbox.entries.filter(e=>e.body===expected);assert.equal(received.length,1)
    if(role==='host')await send()
    write(role+'-received.json',true);await waitFile(other+'-received.json')
    await wait(`[...document.querySelectorAll('.connection-row')].some(e=>e.textContent.includes('Connected'))`)
    await capture(role+'-mail-delivered')
    checks.push({name:'two-engine-local-mail-delivery',status:'PASS',receivedExactlyOnce:true});finish()
  }catch(error){finish(error)}
})})
require(path.join(target,'dist/main/index.cjs'))
