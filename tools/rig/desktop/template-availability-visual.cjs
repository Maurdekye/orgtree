// Standalone Electron test surface; launched only by the visual runner.
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
const staleSelected = process.argv.includes('--stale-selected')
  ? process.argv[process.argv.indexOf('--stale-selected') + 1] : null
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const wait = selector => win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const found=()=>document.querySelector(${JSON.stringify(selector)});
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe element missing'))},5000);
  })`)
  const paint = () => win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
  const attempts = []
  // Require painted warning text AND text in both model controls. A ready
  // DOM alone cannot establish which compositor frame capturePage returned.
  const inspectPixels = (frame, geometry) => {
    const size = frame.getSize(), bitmap = frame.toBitmap()
    if (bitmap.length !== size.width * size.height * 4) throw Error('unsupported capture bitmap size')
    const sx = size.width / geometry.viewport.w, sy = size.height / geometry.viewport.h
    return geometry.targets.map(({ name, rect, color }) => {
      const x0 = Math.max(0, Math.ceil(rect.x * sx)), y0 = Math.max(0, Math.ceil(rect.y * sy))
      const x1 = Math.min(size.width, Math.floor((rect.x + rect.w) * sx))
      const y1 = Math.min(size.height, Math.floor((rect.y + rect.h) * sy))
      let ink = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const offset = (y * size.width + x) * 4
        if (Math.abs(bitmap[offset + 2] - color[0]) <= 20 &&
            Math.abs(bitmap[offset + 1] - color[1]) <= 20 &&
            Math.abs(bitmap[offset] - color[2]) <= 20) ink++
      }
      return { name, ink, painted: ink >= 20 }
    })
  }
  const captureSelected = async theme => {
    const geometry = await win.webContents.executeJavaScript(`(()=>{
      const warning=document.querySelector('.tp-unusable-warning'),models=[...document.querySelectorAll('.tp-preview select')];
      const target=(el,name)=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);
        return {name,rect:{x:r.x,y:r.y,w:r.width,h:r.height},color:s.color.match(/[\\d.]+/g).slice(0,3).map(Number)}};
      return {viewport:{w:innerWidth,h:innerHeight},targets:[target(warning,'warning'),...models.map((el,i)=>target(el,'model-'+i))]};
    })()`)
    if (geometry.targets.length !== 3) throw Error('expected warning and two model controls')
    if (theme === 'dark' && staleSelected) {
      const pixels = inspectPixels(nativeImage.createFromPath(staleSelected), geometry)
      attempts.push({ theme, negativeControl: staleSelected, pixels })
      fs.writeFileSync(path.join(out, 'capture-attempts.json'), JSON.stringify(attempts, null, 2))
      if (pixels.every(p => p.painted)) throw Error('stale-frame negative control passed the pixel gate')
    }
    for (let attempt = 1; attempt <= 8; attempt++) {
      const frame = await win.webContents.capturePage(), pixels = inspectPixels(frame, geometry)
      attempts.push({ theme, attempt, pixels })
      fs.writeFileSync(path.join(out, 'capture-attempts.json'), JSON.stringify(attempts, null, 2))
      if (pixels.every(p => p.painted)) return { frame, attempt, pixels }
      await new Promise(resolve => setTimeout(resolve, 100)); await paint()
    }
    throw Error(`selected ${theme} frame did not paint its warning and model controls`)
  }
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait('button[title="/fixture/01-missing.json"]')
    const checks = []
    for (const light of [false, true]) {
      await win.webContents.executeJavaScript(`window.presetVisual.contrast(${light});window.presetVisual.select('')`)
      await wait('.tp-row.collapsed')
      await new Promise(resolve => setTimeout(resolve, 100))
      const list = await win.webContents.executeJavaScript(`(()=>{
        const rows=[...document.querySelectorAll('.tp-row')],missing=rows[1],ready=rows[2];
        return {compact:missing.classList.contains('collapsed'),selectable:!missing.disabled,
          noDetails:!missing.querySelector('.tp-mini,.tp-desc,.tp-count'),
          dim:getComputedStyle(missing.querySelector('.tp-name')).color!==getComputedStyle(ready.querySelector('.tp-name')).color,
          order:rows.map(row=>row.querySelector('.tp-name').textContent),background:getComputedStyle(document.body).backgroundColor};
      })()`)
      // DOM readiness can precede the compositor frame used by capturePage.
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      fs.writeFileSync(path.join(out, `${light ? 'light' : 'dark'}-list.png`), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript("window.presetVisual.select('missing')")
      await wait('.tp-unusable-warning')
      await new Promise(resolve => setTimeout(resolve, 100))
      await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
      const selected = await win.webContents.executeJavaScript(`({warning:document.querySelector('.tp-unusable-warning').textContent,
        models:document.querySelectorAll('.tp-preview select').length,expanded:!document.querySelector('.tp-row.sel').classList.contains('collapsed')})`)
      const capture = await captureSelected(light ? 'light' : 'dark')
      fs.writeFileSync(path.join(out, `${light ? 'light' : 'dark'}-selected.png`), capture.frame.toPNG())
      selected.capture = { attempt: capture.attempt, pixels: capture.pixels }
      checks.push({ theme: light ? 'light' : 'dark', list, selected })
    }
    const passed = checks.every(c => c.list.compact && c.list.selectable && c.list.noDetails && c.list.dim &&
      c.selected.expanded && c.selected.models === 2 && c.selected.warning.includes('unless you change their models')) &&
      checks[0].list.background !== checks[1].list.background
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
