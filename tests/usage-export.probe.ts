import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { configureEngineSession, configureWindow } from '../apps/desktop/main/windows'

const build = process.env.USAGE_EXPORT_BUILD!, state = process.env.USAGE_EXPORT_STATE!
app.setPath('userData', path.join(state, 'profile'))
app.commandLine.appendSwitch('disable-background-networking')
const checks: { name: string; ok: boolean; detail?: unknown }[] = [], downloads: any[] = [], consoleErrors: string[] = []
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, detail }); console.log(JSON.stringify({ name, ok, detail })) }
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => Promise<boolean>, label: string) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(50) }
  throw Error('Timeout: ' + label)
}
async function click(w: BrowserWindow, selector: string, keyboard = false) {
  const hit = await w.webContents.executeJavaScript(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);el.focus();return {x,y,hit:document.elementFromPoint(x,y)?.closest('button')===el}})()`)
  check('native control hit ' + selector, hit.hit)
  if (keyboard) { w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }) }
  else {
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: hit.x, y: hit.y, clickCount: 1 })
    w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: hit.x, y: hit.y, clickCount: 1 })
  }
  await pause(100)
}
let server: http.Server | undefined, main: BrowserWindow | undefined
app.whenReady().then(async () => {
  const native = session.fromPartition('usage-export-proof')
  native.on('will-download', (_e, item, contents) => {
    const index = downloads.length, filename = item.getFilename(), file = path.join(build, 'downloads', index + '-' + filename)
    const row = { filename, file, window: contents.id, mime: item.getMimeType(), done: false, content: '', state: '' }
    downloads.push(row); item.setSavePath(file)
    item.once('done', (_event, status) => { row.state = status; row.done = true; if (status === 'completed') row.content = fs.readFileSync(file, 'utf8') })
  })
  fs.mkdirSync(path.join(build, 'downloads'), { recursive: true })
  server = http.createServer((req, res) => {
    const route = req.url?.split('?')[0]
    if (route === '/renderer.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(build, 'renderer.js'))) }
    else if (route === '/styles.css') { res.setHeader('Content-Type', 'text/css'); res.end(fs.readFileSync(path.join(build, 'styles.css'))) }
    else if (route === '/') res.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/renderer.js"></script></body></html>')
    else { res.writeHead(404); res.end('synthetic fixture only') }
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const register = configureEngineSession(native, () => origin, () => 'synthetic')
  main = new BrowserWindow({ width: 1180, height: 870, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, session: native, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  configureWindow(main, () => origin, true, register)
  main.webContents.on('console-message', (_e, level, message) => { if (level >= 3) consoleErrors.push(message) })
  await main.loadURL(origin)
  await until(async () => await main!.webContents.executeJavaScript(`document.querySelectorAll('.uh-card').length===2 && !!document.querySelector('.uh-reset')`), 'two chart cards')
  await main.webContents.executeJavaScript(`(()=>{const s=document.querySelectorAll('.uh-filter select')[1];s.value='openai/primary';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await until(async () => await main!.webContents.executeJavaScript(`document.querySelectorAll('.uh-card').length===1`), 'account filter')
  for (const place of ['main', 'popout']) {
    let w = main
    if (place === 'popout') {
      await click(main, 'button.popout-button')
      await until(async () => BrowserWindow.getAllWindows().length === 2, 'native popout')
      w = BrowserWindow.getAllWindows().find(c => c !== main)!
      await until(async () => await w!.webContents.executeJavaScript(`!!document.querySelector('.uh-export-btn')`), 'adopted card')
      await click(w, '.uh-ranges button:first-child')
      await until(async () => await w!.webContents.executeJavaScript(`document.querySelector('.uh-range.on')?.textContent==='24 hours' && document.querySelector('.uh-period')?.textContent.includes('Oct 12')`), 'new period')
    }
    const features = await w!.webContents.executeJavaScript(`(()=>{const plot=document.querySelector('.uh-plot svg');const r=plot.getBoundingClientRect();plot.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+120,clientY:r.top+40}));return {cards:document.querySelectorAll('.uh-card').length,buttons:[...document.querySelectorAll('.uh-export-btn')].map(b=>({text:b.textContent,label:b.getAttribute('aria-label')})),now:!!document.querySelector('.uh-now'),table:!!document.querySelector('.uh-table'),reset:!!document.querySelector('.uh-reset'),future:!!document.querySelector('.uh-future'),end:!!document.querySelector('.uh-end'),next:!!document.querySelector('.uh-next-reset')}})()`)
    check(place + ' exports replace table', features.cards === 1 && !features.table && features.buttons.length === 2 && features.buttons[0].text === 'CSV' && features.buttons[1].text === 'JSONL' && features.buttons.every((b: any) => b.label.startsWith('Export ')), features)
    check(place + ' now removed/reset future end retained', !features.now && features.reset && features.future && features.end && features.next, features)
    await pause(50)
    check(place + ' hover crosshair retained', await w!.webContents.executeJavaScript(`!!document.querySelector('.uh-cross')`))
    const image = await w!.webContents.capturePage(); fs.writeFileSync(path.join(build, place + '.png'), image.toPNG())
    for (const format of ['csv', 'jsonl']) {
      const index = downloads.length
      await click(w!, `.uh-export-btn[aria-label$="${format.toUpperCase()}"]`, format === 'jsonl')
      await until(async () => !!downloads[index]?.done, place + ' ' + format + ' native download')
      const d = downloads[index], expected = place === 'main' ? [65, 90, 2, 17.3456789] : [2, 17.3456789]
      check(place + ' ' + format + ' completed in originating window', d.state === 'completed' && d.window === w!.webContents.id, d)
      check(place + ' ' + format + ' filename uses selected period', d.filename.startsWith('usage-openai-openai-primary-session-5h-all-') && d.filename.endsWith((place === 'main' ? '2026-10-06' : '2026-10-12') + '_2026-10-13.' + format), d.filename)
      const rows = format === 'jsonl' ? d.content.trimEnd().split('\n').map((line: string) => JSON.parse(line))
        : d.content.trimEnd().split('\r\n').slice(1).map((line: string) => { const f = line.split(','); return { timestamp: f[0], value: Number(f[1]), provider: f[2], account: f[3], window: f[4], group: f[5], model: f[6], kind: f[7], unit: f[8] } })
      check(place + ' ' + format + ' exact filtered measured readings/identity', JSON.stringify(rows.map((r: any) => r.value)) === JSON.stringify(expected)
        && rows.every((r: any) => r.provider === 'openai' && r.account === 'openai/primary' && r.window === 'session' && r.group === '5h' && r.model === '' && r.kind === 'percent' && (format === 'csv' ? r.unit === '' : r.unit === null) && r.timestamp.endsWith('Z'))
        && rows.every((r: any, i: number) => !i || r.timestamp >= rows[i - 1].timestamp), rows)
    }
  }
  const errors = await main.webContents.executeJavaScript('proof.errors')
  check('no renderer errors', errors.length === 0 && consoleErrors.length === 0, { errors, consoleErrors })
  check('only synthetic usage-history requests', await main.webContents.executeJavaScript(`proof.requests.every(u=>u.startsWith('/api/usage/history?range='))`))
}).catch(e => check('probe finished', false, String(e))).finally(async () => {
  try { if (main && !main.isDestroyed()) await main.webContents.executeJavaScript('proof?.dispose()') } catch {}
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  await new Promise<void>(r => server ? server.close(() => r()) : r())
  fs.writeFileSync(path.join(build, 'result.json'), JSON.stringify({ checks, downloads, passed: checks.filter(c => c.ok).length, total: checks.length }, null, 2))
  app.exit(checks.every(c => c.ok) ? 0 : 1)
})
