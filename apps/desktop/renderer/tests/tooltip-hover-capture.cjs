const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const out = process.env.ORGTREE_TOOLTIP_CAPTURE_ROOT
assert.match(out || '', /^C:[\\/]orgtree-build[\\/]compaction-cmds-sol[\\/]/i)
for (const key of ['userData','sessionData','logs','crashDumps']) {
  const dir = path.join(out, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir)
}
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const paint = win => win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,100))))')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 650, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const cases = []
  try {
    win.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:)/.test(d.url) }))
    await win.loadFile(path.join(out, 'index.html')); await paint(win)
    for (const theme of ['dark','light']) {
      await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${theme === 'light'})`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await paint(win)
      const point = await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.desk-sample .watchdog-link'),r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await paint(win)
      const before = await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.desk-sample .watchdog-link');window.titleMutations=[];window.titleObserver=new MutationObserver(rs=>window.titleMutations.push(...rs.map(r=>r.attributeName)));window.titleObserver.observe(el,{attributes:true,attributeFilter:['title']});return{title:el.title,text:el.textContent,hover:el.matches(':hover')}})()`)
      assert.equal(before.hover, true)
      await win.webContents.executeJavaScript('window.advanceTooltipClock();new Promise(r=>setTimeout(r,1200))')
      const after = await win.webContents.executeJavaScript(`(()=>{const el=document.querySelector('.desk-sample .watchdog-link');window.inspectTooltip();return{title:el.title,text:el.textContent,mutations:window.titleMutations,labels:Array.from(document.querySelectorAll('.wd-next-check')).map(x=>x.textContent.trim())}})()`)
      assert.equal(after.title, before.title)
      assert.notEqual(after.text, before.text)
      assert.deepEqual(after.mutations, [])
      assert.ok(after.labels.every(label => !label.includes('next check in')))
      assert.match(after.title, /next check in/)
      await paint(win)
      fs.writeFileSync(path.join(out, `tooltip-hover-${theme}.png`), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript('window.titleObserver.disconnect()')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await paint(win)
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await paint(win)
      const fresh = await win.webContents.executeJavaScript(`document.querySelector('.desk-sample .watchdog-link').title`)
      assert.notEqual(fresh, before.title)
      cases.push({ theme, before, after, fresh })
    }
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ passed: true, cases }, null, 2))
    win.destroy(); app.exit(0)
  } catch (error) {
    fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ passed: false, error: error.stack, cases }, null, 2))
    win.destroy(); app.exit(1)
  }
})
