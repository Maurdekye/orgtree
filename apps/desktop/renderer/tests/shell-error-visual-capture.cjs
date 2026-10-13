const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.SCRATCH_VISUAL_ROOT
const evidence = process.env.SCRATCH_VISUAL_EVIDENCE
fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
const receipts = []
const darkFrames = new Map()
const waitFor = condition => `new Promise((resolve,reject) => {
  const deadline=Date.now()+8000;
  const id=setInterval(() => { if(${condition}) {clearInterval(id);resolve()} else if(Date.now()>deadline) {clearInterval(id);reject(new Error('visual fixture timeout'))} },20);
})`
const paint = `new Promise((resolve,reject) => {
  const deadline=setTimeout(() => reject(new Error('visual paint timeout')),2000);
  requestAnimationFrame(() => requestAnimationFrame(() => {clearTimeout(deadline);resolve()}));
})`
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 650, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  try {
    for (const version of ['before', 'after']) for (const theme of ['dark', 'light']) {
      await win.loadFile(path.join(root, version + '.html'))
      await win.webContents.executeJavaScript(waitFor("document.querySelectorAll('.tline').length===2"))
      await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light', ${theme === 'light'})`)
      for (const expanded of [false, true]) {
        if (expanded) {
          await win.webContents.executeJavaScript("document.querySelector('.tline').click();document.querySelectorAll('.tline')[1].click()")
          await win.webContents.executeJavaScript(waitFor("document.querySelectorAll('pre.respre').length===2"))
        }
        const state = await win.webContents.executeJavaScript(`({summary:document.querySelector('.tline').textContent,
          text:document.body.textContent,expanded:document.querySelectorAll('pre.respre').length,
          light:document.documentElement.classList.contains('contrast-light'),
          colorScheme:getComputedStyle(document.documentElement).colorScheme,
          background:getComputedStyle(document.body).backgroundColor,
          timings:[...document.querySelectorAll('.tchip')].map(el => ({writing:el.querySelectorAll('.tool-writing-time').length,execution:el.querySelectorAll('.tool-exec-time').length}))})`)
        if (state.light !== (theme === 'light') || state.colorScheme !== theme) throw new Error('theme class/color-scheme mismatch')
        const expectedRGB = state.background.match(/\d+/g).slice(0, 3).map(Number)
        if (theme === 'light' ? expectedRGB.some(x => x < 180) : expectedRGB.some(x => x > 80)) throw new Error('computed background has wrong theme')
        if (version === 'before' && !expanded && !state.text.includes('SYNTHETIC_ERROR')) throw new Error('before control missing inline error')
        if (version === 'after' && !expanded && (/SYNTHETIC_ERROR/.test(state.text) || !state.summary.includes('an error occurred'))) throw new Error('collapsed error indicator/leak mismatch')
        if (version === 'after' && expanded && !state.text.includes('FULL_OUTPUT_END')) throw new Error('full expansion missing')
        if (expanded && !state.text.includes('SUCCESS_OUTPUT')) throw new Error('successful output changed')
        if (version === 'after' && state.timings.some(t => t.writing !== 1 || t.execution !== 1)) throw new Error('tool durations are missing or duplicated')
        const name = `${version}-${theme}-${expanded ? 'expanded' : 'collapsed'}`
        let screenshot, capturedRGB, attempts = 0
        const captureDeadline = Date.now() + 5000
        do {
          await win.webContents.executeJavaScript(paint)
          screenshot = await win.webContents.capturePage()
          const size = screenshot.getSize(), bitmap = screenshot.toBitmap()
          const offset = ((size.height - 24) * size.width + size.width - 24) * 4
          capturedRGB = [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
          attempts++
          if (capturedRGB.every((x, i) => Math.abs(x - expectedRGB[i]) <= 2)) break
          if (Date.now() > captureDeadline) throw new Error(`captured theme mismatch: expected ${expectedRGB}, got ${capturedRGB}`)
        } while (true)
        const png = screenshot.toPNG(), key = `${version}-${expanded}`
        if (theme === 'dark') darkFrames.set(key, png)
        else if (png.equals(darkFrames.get(key))) throw new Error('light capture duplicates dark frame')
        fs.writeFileSync(path.join(evidence, name + '.png'), png)
        state.capturedRGB = capturedRGB; state.paintAttempts = attempts
        if (version === 'after' && expanded) {
          const copy = await win.webContents.executeJavaScript(`(async () => {
            let copied='';
            Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text => {copied=text}}});
            const pre=document.querySelector('pre.respre');
            const range=document.createRange();range.selectNodeContents(pre);
            const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
            const selected=selection.toString();selection.removeAllRanges();
            pre.closest('.codewrap').querySelector('.code-copy').click();await Promise.resolve();
            return {copied,selected,full:pre.textContent};
          })()`)
          if (copy.copied !== copy.full || copy.selected !== copy.full) throw new Error('expanded full error copy/select mismatch')
          state.copyAndSelectFull = true
        }
        receipts.push({ name, ...state })
      }
    }
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, receipts }, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), e => { console.error(e); app.exit(1) })
