// Capture the project desk's message box of tests/projectinboxwarning-visual.tsx,
// dark and light, after checking where the inbox note sits (capture.json). Run
// Electron on this file from the repository root, with
// INBOX_WARNING_CAPTURE_ROOT set to a folder of your own under C:/orgtree-build
// (ORGTREE_NODE_MODULES: the shared node_modules, which holds esbuild).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = process.env.INBOX_WARNING_CAPTURE_ROOT
if (!/^C:[\\/]orgtree-build[\\/][^\\/]+[\\/][^\\/]/i.test(root || '')) {
  throw new Error('INBOX_WARNING_CAPTURE_ROOT must be a folder under C:/orgtree-build/<you>/')
}
const modules = process.env.ORGTREE_NODE_MODULES || 'E:/Libraries/Desktop/orgtree/node_modules'
const repo = process.cwd()
fs.mkdirSync(root, { recursive: true })
require(path.join(modules, 'esbuild')).buildSync({
  entryPoints: [path.join(repo, 'apps/desktop/renderer/tests/projectinboxwarning-visual.tsx')],
  bundle: true, platform: 'browser', format: 'esm', outfile: path.join(root, 'fixture.js'),
  nodePaths: [modules], logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"' },
})
fs.copyFileSync(path.join(repo, 'apps/desktop/renderer/src/styles.css'), path.join(root, 'styles.css'))
fs.writeFileSync(path.join(root, 'fixture.html'),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"></head>' +
  '<body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>')

// what each case must show: the note, and the staged attachment row
const expect = { none: { note: true, attach: false }, attached: { note: true, attach: true }, listened: { note: false, attach: false } }
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
        const box=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();return {top:Math.round(r.top),bottom:Math.round(r.bottom),left:Math.round(r.left),right:Math.round(r.right)}}
        const note=document.querySelector('.inbox-no-listeners')
        const style=note&&getComputedStyle(note)
        // the bare desk is display: contents; its body is the flex column the box sits in
        const body=document.querySelector('.project-desk .desk-body')
        return {note:box(note),composer:box(document.querySelector('.project-composer')),
          attach:box(document.querySelector('.project-desk .attach-row')),desk:box(body),
          gap:body?parseFloat(getComputedStyle(body).rowGap)||0:null,
          noteText:note?note.innerText:null,noteColor:style?style.color:null,
          light:document.documentElement.classList.contains('contrast-light')}
      })()`)
      const problems = []
      const apart = (upper, lower) => Math.abs(lower.top - upper.bottom - seen.gap) <= 1
      if (!!seen.note !== want.note) problems.push(`note ${!!seen.note}, expected ${want.note}`)
      if (!!seen.attach !== want.attach) problems.push(`attachment row ${!!seen.attach}, expected ${want.attach}`)
      if (seen.light !== (theme === 'light')) problems.push('wrong theme')
      if (!seen.desk || seen.desk.bottom - seen.desk.top < 600) problems.push('the desk body does not fill its frame')
      if (!seen.composer || !seen.desk || seen.desk.bottom - seen.composer.bottom > 4) problems.push('the box is not at the desk\'s foot')
      if (seen.note && !apart(seen.note, seen.composer)) problems.push('the note is not right above the box')
      if (seen.note && seen.attach && !apart(seen.attach, seen.note)) problems.push('the attachment row is not right above the note')
      if (problems.length) throw new Error(`${name}/${theme}: ${problems.join('; ')} ${JSON.stringify(seen)}`)
      await win.webContents.executeJavaScript(settle)
      const image = await win.webContents.capturePage()
      if (image.isEmpty()) throw new Error('empty frame ' + name + '/' + theme)
      const file = `${name}-${theme}.png`
      fs.writeFileSync(path.join(root, file), image.toPNG())
      receipts.push({ case: name, theme, file, ...seen })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(receipts, null, 2))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
