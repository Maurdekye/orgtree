const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = process.env.RETIRED_CAPTURE_ROOT
assert.match(root || '', /^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
const deps = process.env.ORGTREE_NODE_MODULES || 'E:/Libraries/Desktop/orgtree/node_modules'
fs.mkdirSync(root, { recursive: true })
require(path.join(deps, 'esbuild')).buildSync({ entryPoints: [path.join(process.cwd(), 'apps/desktop/renderer/tests/retiredpages-visual.tsx')],
  outfile: path.join(root, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', nodePaths: [deps], define: { 'process.env.NODE_ENV': '"production"' } })
fs.copyFileSync('apps/desktop/renderer/src/styles.css', path.join(root, 'styles.css'))
fs.writeFileSync(path.join(root, 'fixture.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) { const dir = path.join(root, key); fs.mkdirSync(dir); app.setPath(key, dir) }
app.disableHardwareAcceleration()
const settle = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,200))))'
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  const receipts = []
  try {
    win.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:)/.test(d.url) }))
    for (const theme of ['dark', 'light']) {
      await win.loadFile(path.join(root, 'fixture.html'), { query: { theme } })
      await win.webContents.executeJavaScript(`(async()=>{const end=Date.now()+5000;while(document.querySelectorAll('.pile-row').length!==50){if(Date.now()>end)throw Error('no first page');await new Promise(r=>setTimeout(r,20))}await ${settle}})()`)
      const first = await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.pile-rows'),r=el.getBoundingClientRect();return {rows:document.querySelectorAll('.pile-row').length,requests:window.fixtureRequests(),height:r.height,scrollHeight:el.scrollHeight,overflow:getComputedStyle(el).overflowY,search:!!document.querySelector('input[type=search]'),light:document.documentElement.classList.contains('contrast-light')}})()`)
      assert.equal(first.rows, 50); assert.equal(first.requests, 1); assert.equal(first.search, true); assert.ok(first.scrollHeight > first.height); assert.ok(first.height < 401)
      assert.equal(first.light, theme === 'light')
      await win.webContents.executeJavaScript(settle)
      fs.writeFileSync(path.join(root, `list-${theme}.png`), (await win.webContents.capturePage()).toPNG())
      receipts.push({ theme, mode: 'list', ...first })
      await win.webContents.executeJavaScript(`(()=>{const i=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'needle');i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await win.webContents.executeJavaScript(`(async()=>{const end=Date.now()+5000;while(document.querySelector('.pile-name')?.textContent!=='old-archive-needle'){if(Date.now()>end)throw Error('search failed');await new Promise(r=>setTimeout(r,20))}await ${settle}})()`)
      const search = await win.webContents.executeJavaScript(`({rows:document.querySelectorAll('.pile-row').length,requests:window.fixtureRequests(),text:document.querySelector('.pile-name').textContent,deleteAll:[...document.querySelectorAll('button')].some(b=>b.textContent.includes('delete all 1401'))})`)
      assert.equal(search.rows, 1); assert.equal(search.requests, 2); assert.equal(search.deleteAll, true)
      await win.webContents.executeJavaScript(settle)
      fs.writeFileSync(path.join(root, `search-${theme}.png`), (await win.webContents.capturePage()).toPNG())
      receipts.push({ theme, mode: 'search', ...search })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify(receipts, null, 2))
    console.log(JSON.stringify(receipts)); win.destroy(); app.quit()
  } catch (e) { console.error(e); win.destroy(); app.exit(1) }
})
