// Run only inside rig-opus's shared lock and kernel Job. All endpoints are synthetic.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const env = process.env;
for (const key of ['CROP_JOB_CONTAINED', 'CROP_OUT', 'CROP_DEPS', 'CROP_TOOLS_DEPS', 'CROP_CDP']) if (!env[key]) throw Error('Missing ' + key);
if (env.CROP_JOB_CONTAINED !== '1' || !/^C:[\\/]orgtree-build[\\/]/i.test(env.CROP_OUT)) throw Error('Contained C output required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = path.resolve(env.CROP_OUT);
const hub = fs.existsSync(path.join(root, 'src/components/PictureEditor.tsx'));
const esbuild = createRequire(path.join(env.CROP_TOOLS_DEPS, 'package.json'))('esbuild');
const { launch } = await import(pathToFileURL(path.resolve(env.CROP_CDP)).href);
fs.mkdirSync(out, { recursive: true });
const checks = [], check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(JSON.stringify(checks.at(-1))); };
const results = [];
for (const before of [true, false]) {
  const tag = before ? 'before' : 'after', dir = path.join(out, tag); fs.mkdirSync(dir, { recursive: true });
  const base = env.CROP_BASE || (hub ? '4f3db23410c64dc7975561e329f3406c4329a1ec' : '0f8638fc154fb7c58b46ba530eb193f9921efa87');
  await esbuild.build({ entryPoints: [path.join(root, 'tools/crop.fixture.tsx')], outfile: path.join(dir, 'renderer.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic', loader: { '.md': 'text' },
    // Let the browser bundler select package exports/module entries. require.resolve
    // selects CommonJS icon entries and turns default components into module objects.
    nodePaths: [path.join(env.CROP_DEPS, 'node_modules')],
    plugins: [{ name: 'dependencies-and-predecessor', setup(b) {
      if (before) b.onLoad({ filter: /[/\\](orgpicture|PictureEditor)\.tsx$/ }, a => {
        const rel = path.relative(root, a.path).replaceAll('\\', '/');
        const r = spawnSync('git', ['show', base + ':' + rel], { cwd: root, encoding: 'utf8', windowsHide: true });
        if (r.status) throw Error(r.stderr); return { contents: r.stdout, loader: 'tsx', resolveDir: path.dirname(a.path) };
      });
    } }] }); await esbuild.stop();
  const sheet = name => fs.readFileSync(path.join(root, 'src/styles', name + '.css'), 'utf8');
  const css = mode => (hub ? ['tokens', 'base', 'app', mode === 'mobile' ? 'mobile' : 'desktop', mode === 'mobile' ? 'app-mobile' : 'app-desktop'].map(sheet).join('\n')
    : fs.readFileSync(path.join(root, 'apps/desktop/renderer/src/styles.css'), 'utf8')) + '\n' + (fs.existsSync(path.join(dir, 'renderer.css')) ? fs.readFileSync(path.join(dir, 'renderer.css'), 'utf8') : '');
  const server = http.createServer((req, res) => {
    if (req.url === '/renderer.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(dir, 'renderer.js'))); }
    else if (req.url?.startsWith('/style')) { res.setHeader('Content-Type', 'text/css'); res.end(css(req.url.includes('mobile') ? 'mobile' : 'desktop')); }
    else res.end('<!doctype html><html><head><link rel="icon" href="data:,"><link id="sheet" rel="stylesheet" href="/style-desktop.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); let browser;
  try {
    browser = await launch({ width: 900, height: 950 }); await browser.nav('http://127.0.0.1:' + server.address().port + '/');
    for (const mode of (hub ? ['desktop', 'mobile'] : ['desktop'])) for (const theme of ['dark', 'light']) {
      const label = `${tag}-${mode}-${theme}`;
      await browser.size(mode === 'mobile' ? 390 : 900, 950);
      await browser.send('Emulation.setTouchEmulationEnabled', { enabled: mode === 'mobile' });
      await browser.eval(`document.querySelector('#sheet').href='/style-${mode}.css'`);
      await browser.eval(hub ? `proof.mount('${mode === 'mobile' ? 'android' : 'desktop'}','${theme}',true)` : `proof.mount('claude','${theme === 'dark' ? 'charcoal' : 'light'}',false)`);
      await browser.sleep(150);
      if (hub) await browser.eval("document.querySelector('.profile-picture-button')?.click()");
      await browser.eval('proof.select()'); await browser.sleep(150);
      await browser.shot(path.join(dir, label + '.png'));
      if (before) { check(label + ' predecessor sliders', await browser.count('input[type=range]') === 3); continue; }
      check(label + ' full image square and no sliders', await browser.count('.square-crop-handle') === 4 && await browser.count('.square-crop-image') === 1 && await browser.count('input[type=range]') === 0);
      await browser.eval(`document.querySelector('.square-crop-move').focus()`);
      // Each discrete key is flushed separately by real input, not a batched synthetic loop.
      for (let n = 0; n < 50; n++) {
        const key = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 8 };
        await browser.send('Input.dispatchKeyEvent', { ...key, type: 'rawKeyDown' });
        await browser.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
      }
      await browser.eval(`document.querySelector('.square-crop-stage').scrollIntoView({block:'center'})`);
      const corner = await browser.eval(`(()=>{const r=document.querySelector('.square-crop-se').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      const drag = async (x, y, dx, dy) => {
        if (mode === 'mobile') {
          await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          await browser.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x:x+dx, y:y+dy }] });
          await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x:x+dx, y:y+dy, buttons: 1 });
          await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x:x+dx, y:y+dy, button: 'left', clickCount: 1 });
        }
      };
      const oldSide = await browser.eval(`document.querySelector('.square-crop-move').getBoundingClientRect().width`);
      await drag(corner.x, corner.y, -12, -12); await browser.sleep(60);
      check(label + ' corner resizes', await browser.eval(`document.querySelector('.square-crop-move').getBoundingClientRect().width`) < oldSide);
      const bounds = await browser.eval(`(()=>{const r=document.querySelector('.square-crop-move').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
      check(label + ' square geometry', Math.abs(bounds.w - bounds.h) < 1, bounds);
      await drag(bounds.x, bounds.y, 30, 20);
      await browser.sleep(60);
      const moved = await browser.eval(`(()=>{const r=document.querySelector('.square-crop-move').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
      check(label + ' pointer moves selection', moved.x > bounds.x && moved.y > bounds.y, { bounds, moved });
      await browser.shot(path.join(dir, label + '-moved.png'));
      check(label + ' no horizontal overflow', await browser.eval('document.documentElement.scrollWidth<=window.innerWidth'));
      await browser.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='${hub ? 'Save picture' : 'Save logo'}').click()`); await browser.sleep(100);
      const saved = await browser.eval('proof.saved.at(-1)');
      check(label + ' unchanged save contract', saved?.data === 'BwgJ' && saved.crop.size >= .1 && saved.crop.size < 1 && saved.crop.x > .5 && saved.crop.y > .5, saved);
    }
    check(tag + ' no renderer errors', browser.errors.length === 0, browser.errors);
  } catch (e) { check(tag + ' completes', false, String(e)); }
  finally { if (browser) await browser.close(); await new Promise(r => server.close(r)); }
  results.push({ tag, base });
}
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ results, checks, scope: 'actual editors with synthetic native/HTTP seam; browser touch emulation, not Android WebView/device' }, null, 2));
process.exitCode = checks.every(c => c.ok) ? 0 : 1;
