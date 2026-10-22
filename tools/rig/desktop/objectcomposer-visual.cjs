const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const out = process.argv[2]
if (!out || !path.isAbsolute(out)) throw Error('Absolute output required')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 660, height: 600, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } })
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:)/.test(details.url) }))
  const js = code => win.webContents.executeJavaScript(code)
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await js(`new Promise((resolve,reject)=>{const ready=()=>document.querySelector('[data-object-nav="ticket"]');
      const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();clearTimeout(timer);resolve()}});
      const timer=setTimeout(()=>{observer.disconnect();reject(Error('No ticket rendered'))},8000);
      if(ready()){clearTimeout(timer);resolve()}else observer.observe(document.body,{childList:true,subtree:true})})`)
    const checks = await js(`(async()=>{
      const chip=document.querySelector('[data-object-nav="ticket"]'), box=document.querySelector('fieldset textarea');
      const at={bubbles:true,cancelable:true,button:2,clientX:140,clientY:200};
      chip.dispatchEvent(new PointerEvent('pointerdown',at));chip.dispatchEvent(new MouseEvent('contextmenu',at));
      await new Promise(r=>setTimeout(r,180));
      const buttons=()=>[...document.querySelectorAll('.ctxmenu:not(.ctxmenu-submenu) [role="menuitem"]')].filter(b=>b.closest('[role="menu"]').classList.contains('ctxmenu'));
      const labels=buttons().map(b=>b.textContent.replace('▸','').trim());
      buttons().find(b=>b.textContent.trim()==='Reply').click();
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return {labels,staged:!!document.querySelector('[aria-label="Replying to ticket"]'),focused:document.activeElement===box,text:box.value}
    })()`)
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
    fs.writeFileSync(path.join(out, 'ticket-reply.png'), (await win.webContents.capturePage()).toPNG())
    const passed = checks.labels[0] === 'Mention' && checks.labels[1] === 'Reply' && checks.staged && checks.focused && checks.text === ''
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    console.log(JSON.stringify({ passed, checks })); win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
