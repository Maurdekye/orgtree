const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const out = process.env.WORK_TOOL_TICKET_ROOT
if (!/^C:[\\/]orgtree-build[\\/]agent-tooltip-luna[\\/]work-tool-ticket$/i.test(out || '')) throw Error('Assigned output root required')
app.setPath('userData', path.join(out, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 500, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(out, 'fixture.html'))
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const end=performance.now()+5000;
      while(document.querySelectorAll('.tline [data-object-nav="ticket"]').length!==3){
        if(performance.now()>end)throw Error('Create/update ticket links missing');
        await new Promise(r=>setTimeout(r,20));
      }
      await new Promise(r=>setTimeout(r,150));
      const tickets=[...document.querySelectorAll('.tline [data-object-nav="ticket"]')];
      if(tickets.length!==3)throw Error('Reference lookup removed the links');
      tickets[1].click();
      tickets[2].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:360,clientY:260}));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))));
      return {ids:tickets.map(x=>x.dataset.objectId),lines:[...document.querySelectorAll('.tline')].map(x=>x.textContent),
        opened:window.openedTickets,menu:[...document.querySelectorAll('.ctxmenu [role="menuitem"]')].map(x=>x.textContent.trim())};
    })()`)
    if (result.ids.some(id => id !== 'restore-ticket-cards') || result.opened[0] !== 'restore-ticket-cards'
      || !result.menu.includes('Open details') || !result.menu.includes('Copy slug')) throw Error(JSON.stringify(result))
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(result, null, 2))
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))')
    const png = await win.webContents.capturePage()
    if (png.isEmpty()) throw Error('Empty capture')
    fs.writeFileSync(path.join(out, 'work-tool-ticket.png'), png.toPNG())
  } finally { win.destroy() }
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
