const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = process.env.TOKEN_GLYPH_CAPTURE_ROOT
const mode = process.env.TOKEN_GLYPH_CAPTURE_MODE
if (!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(root || '') || !['before', 'after'].includes(mode))
  throw Error('Expected assigned synthetic capture scope and before/after mode')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 960, height: 480, show: false, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=performance.now()+10000;const timer=setInterval(()=>{
      if(document.querySelectorAll('.token-count').length===4){clearInterval(timer);resolve(true)}
      else if(performance.now()>until){clearInterval(timer);reject(Error('token fixture did not render'))}},20)})`)
    const receipts = []
    for (const theme of ['dark', 'light']) {
      const state = await win.webContents.executeJavaScript(`(async()=>{
        document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,250))));
        return {background:getComputedStyle(document.body).backgroundColor,
          counts:[...document.querySelectorAll('.token-count')].map(el=>({text:el.textContent,label:el.getAttribute('aria-label'),
            svg:el.querySelectorAll('svg').length,glyph:el.querySelector('.token-glyph')?.textContent,
            font:el.querySelector('.token-glyph')&&getComputedStyle(el.querySelector('.token-glyph')).fontFamily,
            hidden:el.querySelector('.token-glyph')?.getAttribute('aria-hidden')}))}
      })()`)
      assert.deepEqual(state.counts.map(c => c.label), ['approximately 1,234 output tokens', 'approximately 42 output tokens', '321 thinking tokens', '0 output tokens'])
      for (const count of state.counts) {
        if (mode === 'before') assert.equal(count.svg, 1)
        else { assert.equal(count.svg, 0); assert.equal(count.glyph, 'T'); assert.equal(count.hidden, 'true'); assert.match(count.font, /Georgia.*serif/) }
      }
      let image, actualBackground
      for (let attempt = 0; attempt < 5; attempt++) {
        await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))')
        image = await win.webContents.capturePage()
        const bitmap = image.toBitmap()
        actualBackground = `rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
        if (actualBackground === state.background) break
      }
      assert.equal(actualBackground, state.background, 'capture pixels must match the current theme')
      assert.equal(image.isEmpty(), false)
      fs.writeFileSync(path.join(root, theme + '.png'), image.toPNG())
      receipts.push({ theme, actualBackground, ...state })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify({ mode, receipts }, null, 2))
    console.log(JSON.stringify({ mode, themes: receipts.length, countsPerTheme: 4 }))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
