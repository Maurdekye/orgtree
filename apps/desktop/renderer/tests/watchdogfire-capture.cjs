// Capture the watchdog fire cards of tests/watchdogfire-visual.tsx, dark and
// light, after checking what each one shows (capture.json). Run Electron on
// this file from the repository root, with WATCHDOG_FIRE_CAPTURE_ROOT set to
// a folder of your own under C:/orgtree-build (ORGTREE_NODE_MODULES: the
// shared node_modules, which holds esbuild).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.WATCHDOG_FIRE_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/][^\\/]+[\\/][^\\/]/i.test(root || '')) {
  throw new Error('WATCHDOG_FIRE_CAPTURE_ROOT must be a folder under C:/orgtree-build/<you>/')
}
const modules = process.env.ORGTREE_NODE_MODULES || 'E:/Libraries/Desktop/orgtree/node_modules'
const repo = process.cwd()
fs.mkdirSync(root, { recursive: true })
require(path.join(modules, 'esbuild')).buildSync({
  entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/watchdogfire-visual.tsx')],
  bundle: true, platform: 'browser', format: 'esm', outfile: path.join(root, 'fixture.js'),
  nodePaths: [modules], logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"' },
})
fs.copyFileSync(path.join(repo, 'apps/desktop/renderer/src/styles.css'), path.join(root, 'styles.css'))
fs.writeFileSync(path.join(root, 'fixture.html'),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head>' +
  '<body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>')

// what each case must show before its frame is kept: fire cards, JSON
// viewers, outside-source header tags
const expect = { sources: [2, 2, 2], json: [3, 3, 0], actions: [1, 1, 0] }
const settle = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,180))))'
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const receipts = []
  try {
    for (const theme of ['dark', 'light']) for (const [name, want] of Object.entries(expect)) {
      await win.loadFile(path.join(root, 'fixture.html'), { query: { case: name, theme } })
      const seen = await win.webContents.executeJavaScript(`(async()=>{
        const end=performance.now()+5000
        while(document.body.dataset.ready!=='true'){if(performance.now()>end)throw Error('fixture never rendered');await new Promise(r=>setTimeout(r,20))}
        await ${settle}
        return {cards:document.querySelectorAll('[data-event-variant="monitor.watchdog_fired"]').length,
          viewers:document.querySelectorAll('.sj').length,tags:document.querySelectorAll('.event-head .event-external').length,
          light:document.documentElement.classList.contains('contrast-light'),
          folded:document.querySelectorAll('.turn-mail-preview.folded').length,
          height:document.documentElement.scrollHeight,text:document.body.innerText}
      })()`)
      const got = [seen.cards, seen.viewers, seen.tags]
      if (got.join() !== want.join() || seen.light !== (theme === 'light')) {
        throw new Error(`${name}/${theme}: expected cards, viewers, tags ${want}, saw ${got} (light ${seen.light})`)
      }
      await win.webContents.executeJavaScript(settle)
      const image = await win.webContents.capturePage()
      if (image.isEmpty()) throw new Error('empty frame ' + name + '/' + theme)
      const file = `${name}-${theme}.png`
      fs.writeFileSync(path.join(root, file), image.toPNG())
      receipts.push({ case: name, theme, file, ...seen })
      // the transcript folds received mail past 5 lines: show it opened too
      if (!seen.folded) continue
      const open = await win.webContents.executeJavaScript(`(async()=>{
        for(const b of document.querySelectorAll('.turn-mail-toggle[aria-expanded="false"]'))b.click()
        await ${settle}
        return {folded:document.querySelectorAll('.turn-mail-preview.folded').length,height:document.documentElement.scrollHeight}
      })()`)
      if (open.folded) throw new Error(`${name}/${theme}: ${open.folded} mail still folded after expanding`)
      const opened = await win.webContents.capturePage()
      if (opened.isEmpty()) throw new Error('empty frame ' + name + '/' + theme + ' expanded')
      fs.writeFileSync(path.join(root, `${name}-${theme}-expanded.png`), opened.toPNG())
      receipts.push({ case: name, theme, file: `${name}-${theme}-expanded.png`, expanded: seen.folded, height: open.height })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(receipts, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
