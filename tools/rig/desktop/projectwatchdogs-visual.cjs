// Project watchdog captures: the project desk's dog cards (three, then eleven as one group card), the Listeners
// tab's Event sources, and Recently Fired source links, in charcoal and light.
//
// Isolation is the repo's shared guard (apps/desktop/renderer/tests/chipcapture-guard.cjs; team TEST WINDOW
// ISOLATION + SILENT TESTS): the page loads INERT (index.html has no script); createGuard measures every process in
// Windows Session 0, --mute-audio and muted webContents, the permission handlers, main-process clipboard stubs and the
// main-world page clipboard guard, and only then guard.load() adds fixture.js. guard.finish() re-measures and throws on
// any breach. Frames are taken with CDP Page.captureScreenshot at an explicit 1100x760 clip (webContents.capturePage on
// Session 0 crops to the service desktop's 1024x768: measured by the OBS capture), and the PNG IHDR sizes are recorded
// and asserted. Console errors fail the run.
//   electron tools/rig/desktop/projectwatchdogs-visual.cjs --probe-out <abs folder>   (tools/rig/projectwatchdogs-visual.mjs runs it)
'use strict'
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createGuard } = require('../../../apps/desktop/renderer/tests/chipcapture-guard.cjs')
const out = process.argv[process.argv.indexOf('--probe-out') + 1]
if (!out || !path.isAbsolute(out)) throw new Error('--probe-out needs an absolute artifact folder')
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const folder = path.join(out, key); fs.mkdirSync(folder, { recursive: true }); app.setPath(key, folder)
}
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('mute-audio')
app.on('window-all-closed', () => {})
const W = 1100, H = 760
const ihdr = png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) })

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

app.whenReady().then(async () => {
  const errors = [], harnessNoise = []
  try {
    const guard = createGuard({ electron: require('electron'), out, width: W, height: H, partition: 'project-watchdogs' })
    const { wc, js } = guard
    wc.on('console-message', (_e, level, message) => { if (level >= 2) (/Electron Security Warning/.test(message) ? harnessNoise : errors).push(message) })
    await guard.emulate({ width: W, height: H, deviceScaleFactor: 1, mobile: false })
    await guard.load(path.join(out, 'index.html'), 'fixture.js', 'projectwatchdogs')
    const wait = selector => js(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function check(){if(document.querySelector(${JSON.stringify(selector)}))return resolve(true);if(Date.now()>end)return reject(Error('probe element missing: '+${JSON.stringify(selector)}));setTimeout(check,25)})()})`)
    const paint = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')
    await wait('[data-fixture="few"] .cc-head')
    await wait('[data-fixture="listeners"] .project-listeners')
    const shots = []
    const shot = async (name, top) => {
      await paint()
      const r = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: Math.max(0, top), width: W, height: H, scale: 1 } })
      const png = Buffer.from(r.data, 'base64')
      fs.writeFileSync(path.join(out, name + '.png'), png)
      shots.push({ name, clipTop: Math.max(0, top), ...ihdr(png) })
    }
    const checks = []
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'charcoal'
      await js(`window.pwdVisual.contrast(${light})`)
      await paint()
      const listenersTop = await js(`Math.floor(document.querySelector('[data-fixture="listeners"]').getBoundingClientRect().top + window.scrollY - 8)`)
      await shot(`${theme}-desks`, 0)
      await shot(`${theme}-listeners`, listenersTop)
      checks.push({ theme, facts: await js(`(${probe.toString()})()`) })
    }
    const receipt = await guard.finish()
    const ok = ({ facts: f }) =>
      f.roots === 1
      && f.fewDogs.join(',') === 'stream-chat,stream-control,donations' && f.dogsAfterMembers
      && /11 watchdogs/.test(f.manyGroup) && f.manySingles === 0
      && f.sectionTitles[0] === 'Event sources'
      && f.sources.length === 2 && /member/.test(f.sources[0][1] ?? '') && /you/.test(f.sources[1][1] ?? '')
      && /paused|disabled/.test(f.sources[1][0] ?? '')
      && f.fired.length === 4
      // a live source is a link; a source beyond the tree preview that is NOT gone is not drawn stale; only source.gone is
      && f.fired.find(r => /chat message/.test(r.text))?.link === true && f.fired.find(r => /chat message/.test(r.text))?.gone === false
      && f.fired.find(r => /beyond the tree preview/.test(r.text))?.gone === false
      && f.fired.find(r => /removed dog/.test(r.text))?.gone === true
    const sized = shots.every(s => s.width === W && s.height === H)
    const quiet = errors.length === 0 // stock Electron CSP warnings (harnessNoise) are recorded, not failures
    const passed = checks.every(ok) && sized && quiet
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed, sized, quiet, errors, harnessNoise, shots, guard: receipt, checks }, null, 2))
    console.log(JSON.stringify({ passed, sized, quiet }))
    app.exit(passed ? 0 : 1)
  } catch (error) {
    console.error(error)
    try { fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: String(error), errors }, null, 2)) } catch { /* nothing to add */ }
    app.exit(2)
  }
}).catch(error => { console.error(error); app.exit(2) })
