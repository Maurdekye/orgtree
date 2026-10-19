const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.QUICKCHAT_AGENT_LINK_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]agent-tooltip-luna[\\/]quickchat-agent-links-capture$/i.test(root || '')) {
  throw new Error('Expected assigned Quick chat capture output directory')
}

app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const until=(selector)=>new Promise((resolve,reject)=>{const end=performance.now()+5000;const poll=()=>{
        const el=document.querySelector(selector);if(el)resolve(el);else if(performance.now()>end)reject(Error('Missing '+selector));else setTimeout(poll,20)};poll()});
      const chip=await until('.quickchat-superior[data-agent-nav="boss"]');
      chip.click();
      const row=await until('.quickchat-pop .tray-row[data-agent-nav="boss"]');
      row.dispatchEvent(new Event('pointerover',{bubbles:true}));
      const tooltip=row.title;
      row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:180,clientY:250}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,180))));
      const menu=[...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el=>el.textContent.trim());
      return {chip:chip.getAttribute('data-agent-nav'),row:row.getAttribute('data-agent-nav'),tooltip,menu};
    })()`)
    if (result.chip !== 'boss' || result.row !== 'boss' || result.tooltip !== 'Friendly tooltip for boss'
      || !result.menu.includes('Open boss')) throw new Error('Quick chat link capture did not reach the shared behavior: ' + JSON.stringify(result))
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(result, null, 2))
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,180))))')
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error('Empty screenshot')
    fs.writeFileSync(path.join(root, 'quickchat-agent-links.png'), image.toPNG())
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
