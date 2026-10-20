const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const out = process.env.ORGTREE_PROJECT_OVERLAY_CAPTURE_ROOT
assert.match(out || '', /^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const dir = path.join(out, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir)
}
app.disableHardwareAcceleration()
const settle = win => win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 650, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const cases = []
  try {
    win.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:)/.test(d.url) }))
    await win.loadFile(path.join(out, 'index.html')); await settle(win)
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('contrast-light',${light});
        document.querySelectorAll('.sq').forEach(el => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))`)
      await settle(win)
      const cards = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.sq')).map(card => {
        const name = card.querySelector('.sq-title .name'), full = card.querySelector('.name-full'), style = getComputedStyle(full);
        const first = el => { const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 1); return r.getBoundingClientRect().toJSON() };
        return { id: name.textContent, full: full.textContent, clipped: name.scrollWidth > name.clientWidth,
          background: style.backgroundColor, pointer: style.pointerEvents, font: style.font,
          box: full.getBoundingClientRect().toJSON(), card: card.getBoundingClientRect().toJSON(),
          nameText: first(name), fullText: first(full) };
      })`)
      assert.equal(cards.length, 2)
      for (const c of cards) {
        assert.equal(c.full, c.id); assert.equal(c.clipped, true); assert.equal(c.pointer, 'none')
        assert.ok(c.box.right > c.card.right, 'backdrop extends past card edge')
        assert.ok(Math.abs(c.nameText.x - c.fullText.x) < .1, 'same name x')
        assert.ok(Math.abs(c.nameText.y - c.fullText.y) < .1, 'same name baseline')
      }
      assert.equal(cards[0].background, cards[1].background); assert.equal(cards[0].font, cards[1].font)
      cases.push({ theme, cards }); await settle(win)
      fs.writeFileSync(path.join(out, `project-overlay-${theme}.png`), (await win.webContents.capturePage()).toPNG())
    }
  } finally { win.destroy() }
  fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ passed: true, cases }, null, 2))
  console.log(JSON.stringify({ passed: true, themes: cases.length }))
}).then(() => app.exit(0), e => { console.error(e.stack || e); app.exit(1) })
