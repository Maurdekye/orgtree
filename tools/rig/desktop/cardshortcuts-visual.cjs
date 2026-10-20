// Card shortcut captures (agent-shortcut-badges-stay-rendered-beside-an-op):
// with Show agent card shortcuts on, a project's open desk with the pointer on
// it (no shortcut row may be drawn over it), then the desk closed: the project
// card and an agent card with a live report hovered at overview zoom, and the
// project card below zoom 1. Dark and light. Offscreen and within Session 0's
// 1024x768 display; two animation frames and a pause before every capture
// (team notes, round 439). The pointer is a real mouse move, so :hover is the
// renderer's own.
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
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = selector => js(`new Promise((resolve,reject)=>{
    const found=()=>document.querySelector(${JSON.stringify(selector)});
    if(found()){resolve(true);return} const observer=new MutationObserver(()=>{if(found()){observer.disconnect();clearTimeout(timer);resolve(true)}});
    observer.observe(document.body,{childList:true,subtree:true,attributes:true});
    const timer=setTimeout(()=>{observer.disconnect();reject(Error('probe element missing: '+${JSON.stringify(selector)}))},8000);
  })`)
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const shot = async (name) => { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  /** the pointer onto a card's centre, nudged so its nearest edge is the bottom */
  const hover = async (selector) => {
    const r = await js(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return {x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height*0.62)}})()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x - 3, y: r.y - 3 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y })
    await settle()
  }
  const scene = async (name, ready) => { await js(`window.cardShortcutsVisual.scene(${JSON.stringify(name)})`); await wait(ready); await settle() }
  /** what a card draws in its own shortcut row, and whether the eye sees it */
  const probe = (selector) => js(`(()=>{
    const card = document.querySelector(${JSON.stringify(selector)})
    const seen = b => { const s = getComputedStyle(b), r = b.getBoundingClientRect()
      return s.visibility === 'visible' && Number(s.opacity) > 0.5 && r.width > 0 && r.height > 0 }
    const rows = card.querySelectorAll(':scope > .sq-actions')
    const shortcuts = [...card.querySelectorAll('button.mailbtn, button.presentedbtn, button.gearbtn, button.expandbtn, button.retirebtn')]
    const row = rows[0]
    const rect = row?.getBoundingClientRect()
    return { hovered: card.matches(':hover'), desk: card.classList.contains('desk'), rows: rows.length,
      seenShortcuts: shortcuts.filter(seen).length,
      buttons: row ? [...row.querySelectorAll('button')].map(b => ({ label: b.getAttribute('aria-label') ?? b.className,
        seen: seen(b), w: Math.round(b.getBoundingClientRect().width) })) : [],
      rowLines: row ? new Set([...row.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top))).size : 0,
      rowInsideCard: row ? rect.bottom <= card.getBoundingClientRect().bottom + 0.5 : null,
      hireStrips: [...card.querySelectorAll(':scope > .hsof')].map(h => h.className.replace(/^hsof\\s*/, '')) }
  })()`)
  const P = '.sq.project', A = '.sq:not(.project)'
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait(`${P}.desk .cc-head`)
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'dark'
      await js(`window.cardShortcutsVisual.contrast(${light})`)
      // the user's report: the project's desk is open and the pointer is on it
      await scene('desk', `${P}.desk .cc-head`)
      await hover(P)
      const deskOpen = await probe(P)
      await shot(`${theme}-desk-open-hovered`)
      // the desk closed: its card at overview zoom, then the agent card beside it
      await scene('cards', `${A} .sq-actions`)
      await hover(P)
      const projectCard = await probe(P)
      await shot(`${theme}-project-card-hovered`)
      await hover(A)
      const agentCard = await probe(A)
      await shot(`${theme}-agent-card-hovered`)
      await scene('far', `${A} .sq-actions`)
      await hover(P)
      const farProject = await probe(P)
      await shot(`${theme}-far-project-card-hovered`)
      checks.push({ theme, deskOpen, projectCard, agentCard, farProject })
    }
    const labels = (p) => p.buttons.map(b => b.label)
    const want = ['docket for project', 'mailbox of project', 'presented documents for project', 'team of project',
      'slots of project', 'listeners of project'].map(l => `${l} stack3-03`.replace(/^docket/, 'Docket'))
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    const passed = checks.every(({ deskOpen, projectCard, agentCard, farProject }) =>
      // the open desk, hovered, draws no shortcut, and keeps its hire strips
      deskOpen.hovered && deskOpen.desk && deskOpen.rows === 0 && deskOpen.seenShortcuts === 0
      && deskOpen.hireStrips.length === 4
      // closed, the project card's row is back, every shortcut showing on hover
      && projectCard.hovered && !projectCard.desk && same(labels(projectCard), want)
      && projectCard.buttons.every(b => b.seen) && projectCard.rowInsideCard
      // the agent card with a live report ends its row with Team
      && agentCard.hovered && labels(agentCard).at(-1) === 'team of lead' && agentCard.buttons.at(-1).seen
      && farProject.hovered && same(labels(farProject), want) && farProject.buttons.every(b => b.seen) && farProject.rowInsideCard)
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    console.log(JSON.stringify({ passed }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
