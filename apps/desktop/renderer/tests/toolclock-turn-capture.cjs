// Paint the before/after pages toolclock-turn-pages.mjs builds, in dark and
// light, offscreen, and check what each shows: before this change an earlier
// turn's open call counts live with the executing icon (the user's "23h 08m");
// after it, that call shows as unfinished (arrow and dash) while the running
// turn's own call still counts "33s".
//   CLOCK_VISUAL_ROOT=<the pages' root> CLOCK_VISUAL_EVIDENCE=<D:\orgtree-work\...> electron toolclock-turn-capture.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.CLOCK_VISUAL_ROOT, evidence = process.env.CLOCK_VISUAL_EVIDENCE
if (!/^C:\\orgtree-build\\/i.test(root || '') || !/^D:\\orgtree-work\\/i.test(evidence || '')) throw new Error('Expected C build / D evidence roots')
fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
const receipts = []
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 300, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.startPainting()
  try {
    for (const version of ['before', 'after']) for (const theme of ['dark', 'light']) {
      await win.loadFile(path.join(root, version + '.html'))
      const state = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        const limit=performance.now()+5000;
        const chip=(name)=>{const el=document.querySelector('[data-chip="'+name+'"]');return el&&{
          text:el.textContent.replace(/\\s+/g,' ').trim(),
          live:(el.querySelector('.tool-running')||{}).textContent?.replace(/\\s+/g,' ').trim()||null,
          executing:!!el.querySelector('.tool-running-status'),
          unavailable:!!el.querySelector('[aria-label="execution time unavailable"]')}};
        const id=setInterval(()=>{const old=chip('old'),current=chip('current');
          if(old&&current&&current.live){clearInterval(id);
          document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
          // Allow the changed theme to reach the compositor before requesting a paint.
          requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({old,current,background:getComputedStyle(document.body).backgroundColor})))
        }else if(performance.now()>limit){clearInterval(id);reject(new Error('fixture timeout'))}},20)})`)
      if (state.current.live !== '· 33s' || !state.current.executing) throw new Error(`the running turn's call is not timed: ${JSON.stringify(state.current)}`)
      if (version === 'before' ? !state.old.live || !state.old.executing
        : state.old.live || state.old.executing || !state.old.unavailable || !/—/.test(state.old.text)) {
        throw new Error(`${version}: the earlier turn's call shows ${JSON.stringify(state.old)}`)
      }
      const paint = () => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('paint timeout')), 3000)
        win.webContents.once('paint', (_event, _dirty, image) => { clearTimeout(timeout); resolve(image) })
        win.webContents.invalidate()
      })
      const expected = state.background.match(/\d+/g).slice(0, 3).map(Number)
      let frame, captured, matched = false
      for (let attempt = 0; attempt < 3; attempt++) {
        frame = await paint()
        const bitmap = frame.toBitmap()
        captured = [bitmap[2], bitmap[1], bitmap[0]]
        if (captured.every((value, i) => Math.abs(value - expected[i]) <= 6)) { matched = true; break }
      }
      if (!matched) throw new Error('painted background does not match current theme')
      fs.writeFileSync(path.join(evidence, `${version}-${theme}.png`), frame.toPNG())
      receipts.push({ version, theme, ...state, captured })
      fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: false, receipts }, null, 2))
    }
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, receipts }, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { fs.writeFileSync(path.join(evidence, 'error.txt'), String(error.stack || error)); app.exit(1) })
