import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { launch } from 'file:///D:/orgtree-work/worktrees/hubchat-dm-sol-avatar-edit/tools/cdp.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = process.env.ORG_LOGO_OUT
if (!out?.startsWith('C:\\orgtree-build\\hubchat-dm-sol\\')) throw Error('Owned output required')
const depsRoot = 'E:/Libraries/Desktop/orgtree', req = createRequire(depsRoot + '/package.json'), esbuild = req('esbuild')
fs.mkdirSync(out, { recursive: true })
const checks = [], check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(JSON.stringify({ name, ok: !!ok, detail })) }
const common = { bundle: true, jsx: 'automatic', nodePaths: [depsRoot + '/node_modules'], logLevel: 'warning' }
for (const base of [true, false]) {
  await esbuild.build({ ...common, entryPoints: [root + '/apps/desktop/renderer/tests/orgpicture.test.tsx'], outfile: out + '/' + (base ? 'base' : 'green') + '.mjs', platform: 'node', format: 'esm',
    define: { 'process.env.NODE_ENV': '"development"', __SRC_DIR__: JSON.stringify(root + '/apps/desktop/renderer/src') },
    plugins: [{ name: 'dependencies-and-base', setup(b) {
      b.onResolve({ filter: /^jsdom$/ }, () => ({ path: pathToFileURL(req.resolve('jsdom')).href, external: true }))
      if (base) b.onLoad({ filter: /[/\\]orgpicture(\.test)?\.tsx$/ }, args => {
        const rel = path.relative(root, args.path).replaceAll('\\', '/')
        const p = spawnSync('git', ['show', '9a40732:' + rel], { cwd: root, windowsHide: true, encoding: 'utf8' })
        if (p.status) throw Error(p.stderr)
        return { contents: p.stdout, loader: 'tsx', resolveDir: path.dirname(args.path) }
      })
    } }],
  }); await esbuild.stop()
  const p = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-concurrency=1', '--test-timeout=10000', out + '/' + (base ? 'base' : 'green') + '.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 45000 })
  fs.writeFileSync(out + '/' + (base ? 'base' : 'green') + '-tests.log', p.stdout + p.stderr)
  check((base ? 'base' : 'green') + ' focused owner/crop/Logo tests', p.status === 0, (p.stdout + p.stderr).slice(-1700))
}
await esbuild.build({ ...common, entryPoints: [root + '/tests/org-logo.fixture.tsx'], outfile: out + '/renderer.js', platform: 'browser', format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' } }); await esbuild.stop()
const css = fs.readFileSync(root + '/apps/desktop/renderer/src/styles.css', 'utf8') + '\n' + fs.readFileSync(out + '/renderer.css', 'utf8')
const server = http.createServer((r, s) => {
  if (r.url === '/renderer.js') { s.setHeader('Content-Type', 'text/javascript'); s.end(fs.readFileSync(out + '/renderer.js')) }
  else if (r.url === '/styles.css') { s.setHeader('Content-Type', 'text/css'); s.end(css) }
  else if (r.url === '/') s.end('<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><link rel="icon" href="data:,"></head><body><div id="root"></div><script src="/renderer.js"></script></body></html>')
  else { s.writeHead(404); s.end('fixture only') }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
let browser
try {
  browser = await launch({ width: 900, height: 800 }); await browser.nav('http://127.0.0.1:' + server.address().port + '/', 400)
  const themes = ['orgtree', 'claude', 'codex', 'antigravity', 'openrouter', 'langserver', 'muse', 'custom:#336699']
  for (const theme of themes) for (const contrast of ['charcoal', 'light', 'solarized-light', 'obsidian-black']) {
    await browser.eval(`proof.mount('${theme}','${contrast}',false)`); await browser.sleep(70)
    const view = await browser.eval(`(()=>{const a=document.querySelector('.org-logo-avatar'),p=document.querySelector('.org-logo-pencil');const style=getComputedStyle(a),r=p.getBoundingClientRect();return {initials:a.textContent,color:style.color,fill:style.backgroundColor,font:style.fontSize,round:style.borderRadius,pencil:r.width,chooser:document.querySelector('input[type=file]').hidden,x:!!document.querySelector('.org-logo-remove'),title:document.querySelector('.set-group-head')?.textContent,text:document.querySelector('main').textContent}})()`)
    const light = contrast.includes('light')
    check(theme + ' ' + contrast + ' Hubchat fallback/Logo/pencil', view.initials === 'SO' && view.color === (light ? 'rgb(176, 79, 44)' : 'rgb(227, 137, 107)')
      && view.fill === (light ? 'rgba(217, 119, 87, 0.18)' : 'rgba(217, 119, 87, 0.2)') && view.font === '26px' && view.round === '50%' && view.pencil > 20 && view.chooser && !view.x && view.title === 'Logo' && view.text.includes("org's account picture in Hubchat"), view)
    if (theme !== 'custom:#336699' && (contrast === 'charcoal' || contrast === 'light')) await browser.shot(out + '/' + theme + '-' + contrast + '-empty.png')
  }
  for (const contrast of ['charcoal', 'light']) {
    await browser.eval(`proof.mount('claude','${contrast}',true)`); await browser.sleep(100)
    check(contrast + ' current image and separate X', !!await browser.count('.org-logo-avatar img') && !!await browser.count('button.org-logo-remove'))
    await browser.shot(out + '/' + contrast + '-picture.png')
    const count = await browser.eval('proof.chooser()')
    await browser.mouse('.org-logo-button')
    check(contrast + ' pointer goes straight to chooser', await browser.eval('proof.chooser()') === count + 1)
    await browser.eval(`document.querySelector('.org-logo-button').focus()`); await browser.key('Enter')
    check(contrast + ' Enter chooser', await browser.eval('proof.chooser()') === count + 2)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); await browser.sleep(40)
    check(contrast + ' Space chooser', await browser.eval('proof.chooser()') === count + 3)
    await browser.eval('proof.select()'); await browser.sleep(100)
    check(contrast + ' existing preview and crop flow', !!await browser.count('img[alt="Selected organization logo crop"]'))
    if (contrast === 'charcoal') await browser.shot(out + '/crop.png')
    await browser.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save logo').click()`); await browser.sleep(100)
    check(contrast + ' original bytes/owner/crop save unchanged', await browser.eval(`proof.saved.at(-1).owner===17 && proof.saved.at(-1).data==='BwgJ' && proof.saved.at(-1).crop.size===1`))
    const beforeRemove = await browser.eval('proof.chooser()')
    await browser.mouse('.org-logo-remove')
    check(contrast + ' X removes without chooser', await browser.eval(`proof.saved.at(-1).data===null && !document.querySelector('.org-logo-remove') && proof.chooser()===${beforeRemove}`))
  }
  await browser.mouse('.org-logo-button'); await browser.eval('proof.select(5*1024*1024+1)'); await browser.sleep(50)
  check('same 5 MiB limit', await browser.eval(`document.querySelector('[role=alert]')?.textContent.includes('up to 5 MiB')`))
  await browser.eval('window.fail=true; proof.select()'); await browser.sleep(100)
  check('native error uses Logo wording', await browser.eval(`document.querySelector('[role=alert]')?.textContent.includes('Unsupported logo') && !document.querySelector('[role=alert]')?.textContent.includes('picture')`))
  check('no renderer errors', browser.errors.length === 0, browser.errors)
} catch (e) { check('proof completes', false, String(e)) }
finally { if (browser) { try { await browser.eval('proof.dispose()') } catch {} await browser.close() } await new Promise(r => server.close(r)) }
fs.writeFileSync(out + '/result.json', JSON.stringify({ checks, passed: checks.filter(c => c.ok).length, total: checks.length, scope: 'actual Logo editor/theme browser, synthetic HTTP/image chooser; no engine/Tauri/live acceptance' }, null, 2))
process.exitCode = checks.every(c => c.ok) ? 0 : 1
