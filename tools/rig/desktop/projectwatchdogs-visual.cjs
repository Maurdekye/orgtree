// Project watchdog captures: the project desk's dog cards (three, then eleven as one group card), the Listeners
// tab's Event sources, and Recently Fired source links, in charcoal and light. Offscreen, muted, no network,
// two animation frames and a pause before every capture. Each PASS fact is a probe in result.json.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.commandLine.appendSwitch('mute-audio')
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true, nodeIntegration: false } })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.session.setPermissionRequestHandler((_w, _p, done) => done(false))
  win.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }))
  const js = code => win.webContents.executeJavaScript(code)
  const wait = selector => js(`new Promise((resolve,reject)=>{
    const found=()=>document.querySelector(${JSON.stringify(selector)});
    if(found()){resolve(true);return} const o=new MutationObserver(()=>{if(found()){o.disconnect();clearTimeout(t);resolve(true)}});
    o.observe(document.body,{childList:true,subtree:true,attributes:true});
    const t=setTimeout(()=>{o.disconnect();reject(Error('probe element missing: '+${JSON.stringify(selector)}))},8000);
  })`)
  const settle = async () => {
    await new Promise(r => setTimeout(r, 250))
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))')
  }
  const shot = async name => { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()) }
  const probe = function () {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim()
    const dogNames = sel => [...document.querySelectorAll(sel)].map(c => norm(c.textContent).replace(/^[^A-Za-z0-9]+|1×/g, '').trim())
    const rows = [...document.querySelectorAll('[data-fixture="listeners"] tbody.listeners-sources tr.listener-row')]
    const fired = [...document.querySelectorAll('[data-fixture="listeners"] tr.fired-row.event')]
    const cells = r => [...r.children].map(c => norm(c.textContent))
    const navRows = [...document.querySelectorAll('[data-fixture="few"] .desk-nav')]
    const last = navRows[navRows.length - 1]
    const kids = last ? [...last.children] : []
    const firstDog = kids.findIndex(k => k.classList.contains('desk-dog-chip') || k.querySelector('.desk-dog-chip'))
    const lastMember = kids.map((k, i) => (/member|other/.test(k.textContent) ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    return {
      roots: document.querySelectorAll('#root').length,
      fewDogs: dogNames('[data-fixture="few"] .desk-nav .desk-dog-chip'),
      dogsAfterMembers: firstDog > lastMember && lastMember >= 0,
      manyGroup: norm(document.querySelector('[data-fixture="many"] [data-watchdog-group]')?.textContent),
      manySingles: document.querySelectorAll('[data-fixture="many"] .desk-nav .desk-dog-chip').length,
      sectionTitles: [...document.querySelectorAll('[data-fixture="listeners"] .project-listeners h4')].map(h => h.textContent),
      sources: rows.map(cells),
      fired: fired.map(r => ({ text: norm(r.textContent), link: !!r.querySelector('[data-object-id], .watchdog-link'),
        gone: !!r.querySelector('.gone, .history-dog.gone') })),
    }
  }
  try {
    await win.loadFile(path.join(out, 'index.html'))
    await wait('[data-fixture="few"] .cc-head')
    await wait('[data-fixture="listeners"] .project-listeners')
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'charcoal'
      await js(`window.pwdVisual.contrast(${light})`)
      await shot(theme)
      checks.push({ theme, facts: await js(`(${probe.toString()})()`) })
    }
    const ok = ({ facts: f }) =>
      f.roots === 1
      && f.fewDogs.join(',') === 'stream-chat,stream-control,donations' && f.dogsAfterMembers
      && /11 watchdogs/.test(f.manyGroup) && f.manySingles === 0
      && f.sectionTitles[0] === 'Event sources'
      && f.sources.length === 2 && /member/.test(f.sources[0][1] ?? '') && /you/.test(f.sources[1][1] ?? '')
      && /paused|disabled/.test(f.sources[1][0] ?? '')
      && f.fired.length === 4
      // a live source is a link; a source beyond the preview that is NOT gone is not drawn stale; only source.gone is
      && f.fired.find(r => /chat message/.test(r.text))?.link === true && f.fired.find(r => /chat message/.test(r.text))?.gone === false
      && f.fired.find(r => /beyond the tree preview/.test(r.text))?.gone === false
      && f.fired.find(r => /removed dog/.test(r.text))?.gone === true
    const passed = checks.every(ok)
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, checks }, null, 2))
    console.log(JSON.stringify({ passed }))
    win.destroy(); app.exit(passed ? 0 : 1)
  } catch (error) { console.error(error); win.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
