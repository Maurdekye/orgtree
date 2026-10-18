const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = process.env.TOKEN_GLYPH_CAPTURE_ROOT
const mode = process.env.TOKEN_GLYPH_CAPTURE_MODE
if (!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(root || '') || !['before', 'after', 'spacing-red'].includes(mode))
  throw Error('Expected assigned synthetic capture scope and before/after mode')
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 960, height: 480, show: false, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  try {
    await win.loadFile(path.join(root, 'fixture.html'))
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const until=performance.now()+10000;const timer=setInterval(()=>{
      if(document.querySelectorAll('.token-count').length===4){clearInterval(timer);resolve(true)}
      else if(performance.now()>until){clearInterval(timer);reject(Error('token fixture did not render'))}},20)})`)
    const receipts = []
    // Phase 1 keeps one requested capture; full palettes belong to hardening.
    for (const theme of [process.env.TOKEN_GLYPH_CAPTURE_THEME || 'dark']) {
      assert.ok(['dark', 'light'].includes(theme))
      const state = await win.webContents.executeJavaScript(`(async()=>{
        document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,250))));
        const slots=[...document.querySelector('.tline').querySelectorAll('.tool-writing-time,.tool-exec-time,.token-count')];
        const spacing=slots.map(el=>{
          const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),texts=[];
          for(let node;node=walker.nextNode();) if(!node.parentElement.closest('.token-glyph'))texts.push(node);
          const separator=texts.find(node=>node.textContent.includes('·'));
          const dot=document.createRange(),index=separator.textContent.indexOf('·');
          dot.setStart(separator,index);dot.setEnd(separator,index+1);
          const value=texts.find(node=>node!==separator&&/\\S/.test(node.textContent));
          const number=document.createRange(),first=value.textContent.search(/\\S/);
          number.setStart(value,first);number.setEnd(value,first+1);
          const icon=el.querySelector('svg,.token-glyph').getBoundingClientRect();
          return {separatorToIcon:icon.left-dot.getBoundingClientRect().right,
            iconToNumber:number.getBoundingClientRect().left-icon.right,
            iconWidth:icon.width,separatorLeft:dot.getBoundingClientRect().left,end:el.getBoundingClientRect().right};
        });
        return {background:getComputedStyle(document.body).backgroundColor,spacing,
          writingTitle:document.querySelector('.tool-writing-time')?.getAttribute('title'),
          executionTitle:document.querySelector('.tool-exec-time')?.getAttribute('title'),
          writingIcon:document.querySelector('.tool-writing-time svg')?.getAttribute('data-testid'),
          executionIcon:document.querySelector('.tool-exec-time svg')?.getAttribute('data-testid'),
          counts:[...document.querySelectorAll('.token-count')].map(el=>({text:el.textContent,label:el.getAttribute('aria-label'),title:el.getAttribute('title'),
            svg:el.querySelectorAll('svg').length,glyph:el.querySelector('.token-glyph')?.textContent,
            font:el.querySelector('.token-glyph')&&getComputedStyle(el.querySelector('.token-glyph')).fontFamily,
            hidden:el.querySelector('.token-glyph')?.getAttribute('aria-hidden'),
            cursor:el.querySelector('.token-glyph')?.getAttribute('data-testid')}))}
      })()`)
      assert.deepEqual(state.counts.map(c => c.label), ['approximately 1,234 output tokens', 'approximately 42 output tokens', '321 thinking tokens', '0 output tokens'])
      if (mode !== 'before') {
        assert.equal(state.writingTitle, 'writing time: 4.330ms')
        assert.equal(state.executionTitle, 'execution time: 0.432ms')
        assert.equal(state.writingIcon, 'EditOutlinedIcon')
        assert.equal(state.executionIcon, 'ArrowForwardIcon')
        for (const [i, suffix] of ['~1.2kt', '~42t', '321t', '0t'].entries()) assert.equal(state.counts[i].text.endsWith(suffix), true)
        assert.deepEqual(state.counts.map(c => c.title.split('\n')[0]), ['tool output: ~1,234t', 'tool output: ~42t', 'thinking: 321t', 'tool output: 0t'])
      }
      for (const count of state.counts) {
        if (mode === 'before') assert.equal(count.svg, 1)
        else if(mode==='spacing-red') { assert.equal(count.svg, 0); assert.equal(count.glyph, 'T'); assert.equal(count.hidden, 'true') }
        else { assert.equal(count.svg, 1); assert.equal(count.cursor, 'TextCursorIcon'); assert.equal(count.hidden, 'true') }
      }
      let image, actualBackground
      for (let attempt = 0; attempt < 5; attempt++) {
        await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,100))))')
        image = await win.webContents.capturePage()
        const bitmap = image.toBitmap()
        actualBackground = `rgb(${bitmap[2]}, ${bitmap[1]}, ${bitmap[0]})`
        if (actualBackground === state.background) break
      }
      assert.equal(actualBackground, state.background, 'capture pixels must match the current theme')
      assert.equal(image.isEmpty(), false)
      fs.writeFileSync(path.join(root, theme + '.png'), image.toPNG())
      receipts.push({ theme, actualBackground, ...state })
    }
    fs.writeFileSync(path.join(root, 'capture.json'), JSON.stringify({ mode, receipts }, null, 2))
    if (mode !== 'before') for (const { theme, spacing } of receipts) {
      assert.equal(spacing.length, 3);
      for (const metric of ['separatorToIcon', 'iconToNumber', 'iconWidth'])
        for (const slot of spacing.slice(1)) assert.ok(Math.abs(slot[metric]-spacing[0][metric])<0.1,
          theme+' spacing mismatch: '+metric+' '+JSON.stringify(spacing));
      assert.ok(Math.abs((spacing[2].separatorLeft-spacing[1].end)-(spacing[1].separatorLeft-spacing[0].end))<0.1,
        theme+' spacing mismatch: leading separator gap '+JSON.stringify(spacing));
    }
    console.log(JSON.stringify({ mode, themes: receipts.length, countsPerTheme: 4 }))
  } finally { win.destroy() }
}).then(() => app.exit(0), error => { console.error(error.stack || error); app.exit(1) })
