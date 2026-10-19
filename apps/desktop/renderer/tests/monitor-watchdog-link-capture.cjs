const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.MONITOR_WATCHDOG_LINK_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/]agent-tooltip-luna[\\/]monitor-watchdog-link$/i.test(root || '')) {
  throw new Error('Expected assigned monitor watchdog capture output directory')
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
      const end=performance.now()+5000;let link;
      while(!(link=document.querySelector('.event-actor [data-object-nav="watchdog"]'))){
        if(performance.now()>end)throw Error('Missing stale watchdog link');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      link.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:180,clientY:260}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,180))));
      return {name:link.textContent,title:link.title,disabled:link.getAttribute('aria-disabled'),
        menu:[...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(el=>el.textContent.trim())};
    })()`)
    if (result.disabled !== 'true' || !/no longer exists/i.test(result.title)
      || !result.menu.includes('Watchdog no longer exists') || !result.menu.includes('Copy watchdog name')) {
      throw new Error('Stale watchdog link did not show its safe context menu: ' + JSON.stringify(result))
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(result, null, 2))
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,180))))')
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error('Empty screenshot')
    fs.writeFileSync(path.join(root, 'monitor-watchdog-link.png'), image.toPNG())
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
