// Org mailbox project captures: the holder row (an agent AND a project), the project desk's "org mailbox" chip with its
// revoke, the Mail tab's follow-up chip, and the drop-replace confirm in BOTH directions (project replaces agent, agent
// replaces project), in charcoal and light.
//
// Isolation is the repo's shared guard (apps/desktop/renderer/tests/chipcapture-guard.cjs; team TEST WINDOW
// ISOLATION + SILENT TESTS): the page loads INERT (index.html has no script); createGuard measures every process in
// Windows Session 0, --mute-audio and muted webContents, the permission handlers, main-process clipboard stubs and the
// main-world page clipboard guard, and only then guard.load() adds fixture.js. guard.finish() re-measures and throws on
// any breach. Frames are taken with CDP Page.captureScreenshot at an explicit 1100x760 clip (webContents.capturePage on
// Session 0 crops to the service desktop's 1024x768: measured by the OBS capture), and the PNG IHDR sizes are recorded
// and asserted. Console errors fail the run.
//   electron tools/rig/desktop/orginboxqueue-visual.cjs --probe-out <abs folder>   (tools/rig/orginboxqueue-visual.mjs runs it)
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
  const q = sel => document.querySelector(sel)
  const dialog = q('[role="dialog"], [role="alertdialog"], .modal')
  return {
    roots: document.querySelectorAll('#root').length,
    holders: [...document.querySelectorAll('[data-fixture="holders"] .aud-badge')].map(b => ({ text: norm(b.textContent), title: b.title,
      revoke: !!b.querySelector('button') })),
    chip: q('[data-fixture="chip"] .badge') ? { text: norm(q('[data-fixture="chip"] .badge').textContent), title: q('[data-fixture="chip"] .badge').title,
      revoke: !!q('[data-fixture="chip"] .badge button, [data-fixture="chip"] button') } : null,
    followup: q('[data-fixture="followup"] .mailrow') ? { text: norm(q('[data-fixture="followup"] .mailrow').textContent) } : null,
    panel: q('[data-fixture="panel"]') ? { text: norm(q('[data-fixture="panel"]').textContent),
      holders: [...document.querySelectorAll('[data-fixture="panel"] .aud-badge')].map(b => ({ text: norm(b.textContent), title: b.title, revoke: !!b.querySelector('button') })) } : null,
    dialog: dialog ? norm(dialog.textContent) : null,
  }
}

app.whenReady().then(async () => {
  const errors = [], harnessNoise = []
  try {
    const guard = createGuard({ electron: require('electron'), out, width: W, height: H, partition: 'org-inbox-queue' })
    const { wc, js } = guard
    wc.on('console-message', (_e, level, message) => { if (level >= 2) (/Electron Security Warning.*(Content-Security-Policy|unsafe-eval)/s.test(message) ? harnessNoise : errors).push(message) })
    await guard.emulate({ width: W, height: H, deviceScaleFactor: 1, mobile: false })
    await guard.load(path.join(out, 'index.html'), 'fixture.js', 'orginboxqueue')
    const wait = selector => js(`new Promise((resolve,reject)=>{const end=Date.now()+8000;(function check(){if(document.querySelector(${JSON.stringify(selector)}))return resolve(true);if(Date.now()>end)return reject(Error('probe element missing: '+${JSON.stringify(selector)}));setTimeout(check,25)})()})`)
    const paint = () => js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,150))))')
    await wait('[data-fixture="holders"]')
    const shots = [], checks = []
    const shot = async name => {
      await paint()
      const r = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: W, height: H, scale: 1 } })
      const png = Buffer.from(r.data, 'base64')
      fs.writeFileSync(path.join(out, name + '.png'), png)
      shots.push({ name, ...ihdr(png) })
    }
    for (const light of [false, true]) {
      const theme = light ? 'light' : 'charcoal'
      for (const scene of ['holders', 'panel', 'replace-project', 'replace-agent']) {
        await js(`window.oiVisual.show(${JSON.stringify(scene)}, ${light})`)
        await wait(scene === 'holders' ? '[data-fixture="holders"] .aud-badge' : scene === 'panel' ? '[data-fixture="panel"] .aud-badge' : '[role="dialog"]')
        await shot(`${theme}-${scene}`)
        checks.push({ theme, scene, facts: await js(`(${probe.toString()})()`) })
      }
    }
    const receipt = await guard.finish()
    const ok = ({ scene, facts: f }) => f.roots === 1 && (
      scene === 'holders'
        ? f.holders.length === 2 && /triage/.test(f.holders[0].text) && /intake/.test(f.holders[1].text)
          && /answer outside mail/.test(f.holders[0].title) && /in its queue/.test(f.holders[1].title)
          && f.holders.every(h => h.revoke)
          && f.chip && /org mailbox/.test(f.chip.text) && /in its queue/.test(f.chip.title) && f.chip.revoke
          && f.followup && /one more detail/.test(f.followup.text) && /follow-up to u0123456789ab/.test(f.followup.text)
        : scene === 'panel'
          ? !!f.panel && f.panel.holders.length === 2 && /triage/.test(f.panel.holders[0].text) && /intake/.test(f.panel.holders[1].text)
            && /in its queue/.test(f.panel.holders[1].title) && f.panel.holders.every(h => h.revoke)
            && /drag an agent or a project onto the mailbox/.test(f.panel.text)
        : scene === 'replace-project'
          ? !!f.dialog && /Replace triage as the org mailbox's holder with intake\?/.test(f.dialog) && /Replace/.test(f.dialog)
          : !!f.dialog && /Replace intake as the org mailbox's holder with triage\?/.test(f.dialog) && /Replace/.test(f.dialog))
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
