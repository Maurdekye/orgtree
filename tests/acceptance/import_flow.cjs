const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto')
function sourceHashes(root){const manifest=JSON.parse(fs.readFileSync(path.join(root,'import-manifest.json'),'utf8'));return {manifest,actual:Object.fromEntries(Object.keys(manifest.source_hashes).map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(manifest.source_root,name))).digest('hex')]))}}
exports.copy=async({root,evaluate,waitFor,capture,main,assert})=>{
  const {manifest,actual}=sourceHashes(root);assert.deepEqual(actual,manifest.source_hashes)
  await evaluate(`(()=>{const i=document.querySelector('input[aria-label="V1 data folder"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(manifest.source_root)});i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('.import-settings button')].find(b=>b.textContent==='Preview organizations');if(!b||b.disabled)return false;b.click();return true})()`),true)
  assert.equal(await waitFor(`document.querySelector('input[aria-label="Acknowledge duplicate work"]')`),true)
  assert.equal(await evaluate(`document.querySelector('.import-settings').textContent.includes('Import Demo')`),true)
  assert.equal(await evaluate(`[...document.querySelectorAll('.import-settings button')].find(b=>b.textContent==='Copy selected organizations').disabled`),true)
  await capture(main,'import-preview')
  await evaluate(`document.querySelector('input[aria-label="Acknowledge duplicate work"]').click();true`)
  assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('.import-settings button')].find(b=>b.textContent==='Copy selected organizations');if(!b||b.disabled)return false;b.click();return true})()`),true)
  assert.equal(await waitFor(`document.querySelector('.import-settings [role="status"]')?.textContent.includes('Imported Import Demo.')`),true)
  await capture(main,'import-copied')
  const admissions=fs.readFileSync(path.join(root,'import-admissions.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(admissions.map(a=>a.node),['active'])
  assert.deepEqual(sourceHashes(root).actual,manifest.source_hashes)
  fs.writeFileSync(path.join(root,'import-source-unchanged.json'),JSON.stringify({unchanged:true,files:Object.keys(actual).length,activeAdmissions:1,idleAdmissions:0,providerExecution:false}))
}
exports.read=async({root,evaluate,waitFor,capture,main,assert})=>{
  for(const node of ['active','idle']){
    const chat=await evaluate(`fetch('/api/orgs/import-demo/nodes/${node}/chat').then(r=>r.json())`)
    assert.ok(chat.messages.some(m=>m.imported_history && m.text===`Copied V1 history for ${node}.`))
  }
  if (!await evaluate(`Boolean([...document.querySelectorAll('.org')].find(e=>e.textContent.includes('Import Demo')))`)) {
    assert.equal(await evaluate(`(()=>{const b=document.querySelector('header.orgbar button.iconbtn');if(!b)return false;b.click();return true})()`),true)
  }
  assert.equal(await waitFor(`[...document.querySelectorAll('.org')].some(e=>e.textContent.includes('Import Demo'))`),true,'Imported organization must appear in real selector')
  await evaluate(`[...document.querySelectorAll('.org')].find(e=>e.textContent.includes('Import Demo')).click();true`)
  await capture(main,'import-selected')
  assert.equal(await waitFor(`document.querySelector('header.orgbar h2')?.textContent==='Import Demo'`),true)
  assert.equal(await waitFor(`document.querySelector('[title="open presented documents for active"]')`),true)
  await evaluate(`document.querySelector('[title="open presented documents for active"]').click();true`)
  assert.equal(await waitFor(`document.querySelector('.doc-gallery-row')`),true)
  await evaluate(`document.querySelector('.doc-gallery-row').click();true`)
  assert.equal(await waitFor(`document.querySelector('.mailer-body')?.textContent.includes('This synthetic document must survive the copy.')`),true)
  await capture(main,'imported-document')
  await require('./reply_download_flow.cjs').download({root,evaluate,waitFor,capture,main,assert})
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`)
  assert.equal(await evaluate(`(()=>{const c=[...document.querySelectorAll('.sq')].find(e=>e.querySelector('.name')?.textContent==='active');if(!c)return false;const r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.x+30,clientY:r.y+30}));return true})()`),true)
  assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Open desk');if(!b)return false;b.click();return true})()`),true)
  assert.equal(await waitFor(`document.querySelector('.desk-body')?.textContent.includes('Copied V1 history for active.')`),true)
  await capture(main,'imported-history-desk')
  await require('./reply_download_flow.cjs').reply({root,evaluate,waitFor,capture,main,assert})
  const {manifest,actual}=sourceHashes(root);assert.deepEqual(actual,manifest.source_hashes)
}
