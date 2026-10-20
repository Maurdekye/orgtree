// Retired pile captures (with-hide-retired-agents-off-no-retired-agents-a):
// the whole canvas drawn from a real engine snapshot of 1411 retired agents
// in the live org's shape. "Hide retired agents" off (the user's report: a
// counted pile at the top level, under the big agent, under a project and
// under a pile's front, and the single retiree's card), then on (the
// retired-list tokens), then off again, each flip timed; then zoomed onto
// the big pile. Dark and light. Offscreen and within Session 0's 1024x768
// display; two animation frames and a pause before every capture (team
// notes, round 439).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) })
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = selector => js(`new Promise((resolve,reject)=>{
    const found=()=>document.querySelector(${JSON.stringify(selector)});
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe element missing: '+${JSON.stringify(selector)}))},15000);
  })`)
  const settle = async (ms = 250) => {
    await new Promise(resolve => setTimeout(resolve, ms))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const shot = async (name) => { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  const probe = () => js(`(()=>({
    piles: [...document.querySelectorAll('.pile-stack .pile-count')].map(b => b.textContent).sort(),
    tokens: [...document.querySelectorAll('.retired-token')].map(b => b.textContent).sort(),
    cards: [...document.querySelectorAll('.sq .sq-title .name')].map(n => n.textContent),
  }))()`)
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait('.sq .sq-title .name')
    await settle(2800)   // the intro glide lands
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await js(`window.retiredPilesVisual.contrast(${light})`)
      await settle()
      const off = await probe()
      await shot(`${theme}-hide-off`)
      const onMs = await js('window.retiredPilesVisual.hide(true)')
      await settle()
      const on = await probe()
      await shot(`${theme}-hide-on`)
      const backMs = await js('window.retiredPilesVisual.hide(false)')
      await settle()
      const back = await probe()
      checks.push({ theme, off, on, back, flipMs: { on: Math.round(onMs), off: Math.round(backMs) } })
    }
    // zoom onto the big pile with the wheel, at its own position
    const big = await js(`(()=>{const c=[...document.querySelectorAll('.pile-stack .pile-count')].find(b=>Number(b.textContent)>1000);
      if(!c)return null; const r=c.closest('.pile-stack').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}})()`)
    if (big) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: big.x, y: big.y })
      for (let i = 0; i < 6; i++) {
        win.webContents.sendInputEvent({ type: 'mouseWheel', x: big.x, y: big.y, deltaX: 0, deltaY: 240, wheelTicksY: 2, canScroll: true })
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      await settle(900)
      await shot('light-big-pile-zoomed')
    }
    const metrics = await js('window.retiredPilesVisual.metrics')
    const want = { piles: ['1321', '3', '5', '78'], tokens: ['1 retired', '1321 retired', '3 retired', '78 retired'] }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const passed = checks.every(({ off, on, back }) => same(off.piles, want.piles) && off.tokens.length === 0
        && ['coord-r-1318', 'top-r-76', 'slot-3', 'nest-r-5', 'cmt-1'].every(n => off.cards.includes(n))
        && same(on.tokens, want.tokens) && on.piles.length === 0
        && same(back.piles, want.piles) && back.tokens.length === 0)
      && !!big && errors.length === 0
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, want, checks, metrics, big, errors }, null, 2))
    console.log(JSON.stringify({ passed, metrics, flips: checks.map(c => c.flipMs) }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
