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
  const js = code => win.webContents.executeJavaScript(code)
  try {
    await win.loadFile(path.join(out, 'index.html')); await wait(1000)
    await js(`document.querySelector('input[aria-label="Open desk after manual hire"]').click()`)
    await js(`(() => { const e=document.querySelector('[data-first-use-agent="manager"] .hsof:not(.side) .hire-expand');
      if(e?.getAttribute('aria-expanded')==='false')e.click() })()`)
    await wait(100)
    await js(`document.querySelector('[data-first-use-agent="manager"] .hsof:not(.side) button.t-sol').click()`)
    await wait(1500)
    await js(`(() => { const e=document.querySelector('.sq.draft .df-name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'newcomer');
      e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await wait(100)
    const before = await js(`document.querySelector('.space').style.transform`)
    await js(`document.querySelector('.sq.draft .df-foot button.primary').click()`)
    await wait(2000)
    await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
    const receipt = await js(`(() => ({ enabled: document.querySelector('input[aria-label="Open desk after manual hire"]').checked,
      camera: document.querySelector('.space').style.transform, draft: !!document.querySelector('.sq.draft'),
      newcomer: !!document.querySelector('[data-first-use-agent="newcomer"]'), desk: !!document.querySelector('.sq.desk:not(.user)'),
      hire: window.fixtureHire, width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))()`)
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ before, ...receipt }, null, 2))
    if (receipt.enabled || receipt.camera !== before || receipt.draft || !receipt.newcomer || receipt.desk)
      throw new Error('Off completion behavior did not match')
    fs.writeFileSync(path.join(out, 'hire-focus.png'), (await win.webContents.capturePage()).toPNG())
    console.log(JSON.stringify({ before, ...receipt })); app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
