const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const out = path.resolve(process.argv[2])
if (!out.toLowerCase().startsWith('c:\\orgtree-build\\canvas-sol\\')) throw new Error('outside owned output')
app.setPath('userData', path.join(out, 'electron-profile'))
app.setPath('sessionData', path.join(out, 'electron-session'))
app.disableHardwareAcceleration()
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1500, height: 920, show: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } })
  const errors = []
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message) })
  try {
    await win.loadFile(path.join(out, 'index.html')); await wait(2400)
    await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('select[aria-label="New hires go"]');
      select.value = 'centre'; select.dispatchEvent(new Event('change', {bubbles:true}));
    })()`)
    await wait(100)
    await win.webContents.executeJavaScript(`(() => {
      const expand=document.querySelector('[data-first-use-agent="manager"] .hsof:not(.side) .hire-expand');
      if(expand?.getAttribute('aria-expanded')==='false')expand.click();
    })()`)
    await wait(100)
    await win.webContents.executeJavaScript('document.querySelector(\'[data-first-use-agent="manager"] .hsof:not(.side) button.t-sol\').click()')
    await wait(1500)
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.sq.draft .df-name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'newcomer');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    await wait(100)
    await win.webContents.executeJavaScript('document.querySelector(".sq.draft .df-foot .primary").click()')
    await wait(2400)
    await win.webContents.executeJavaScript('document.querySelector(\'button[title="fit the whole org"]\').click()')
    await wait(1400)
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    const receipt = await win.webContents.executeJavaScript(`(() => ({
      choice:document.querySelector('select[aria-label="New hires go"]').value,
      order:window.fixtureOrder, requests:window.fixtureRequests,
      rects:['alpha','project','newcomer','omega'].map(id=>{
        const e=document.querySelector('[data-first-use-agent="'+id+'"]');
        const r=e?.getBoundingClientRect(); return {id,x:r?.x,y:r?.y,w:r?.width,h:r?.height};
      }),width:innerWidth,height:innerHeight,dpr:devicePixelRatio
    }))()`)
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ ...receipt, errors }, null, 2))
    if (receipt.choice !== 'centre' || receipt.requests.length !== 1 || receipt.order.join(',') !== 'alpha,project,newcomer,omega') throw new Error('centre hire not observed')
    fs.writeFileSync(path.join(out, 'hire-position.png'), (await win.webContents.capturePage()).toPNG())
    console.log(JSON.stringify(receipt)); app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
