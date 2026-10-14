const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const root = process.env.CHIP_VISUAL_ROOT, evidence = process.env.CHIP_VISUAL_EVIDENCE
const fixtureUrl = process.env.CHIP_VISUAL_URL
if (!/^C:\\orgtree-build\\/i.test(root || '') || !/^D:\\orgtree-work\\/i.test(evidence || '')) throw new Error('Expected C build / D evidence roots')
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureUrl||''))throw new Error('Expected synthetic loopback fixture URL')
fs.mkdirSync(evidence, { recursive: true })
app.setPath('userData', path.join(root, 'user-data'))
app.disableHardwareAcceleration()
const receipts = []
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 1100, show: false, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  win.webContents.startPainting()
  try {
    for (const version of ['before', 'after']) for (const theme of ['dark', 'light']) {
      await win.loadURL(fixtureUrl + '/' + version + '.html')
      const state = await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('fixture timeout')),5000);
        const ready=()=>{const image=document.querySelector('.imgcard-img');
          if(document.querySelectorAll('[data-case]').length!==8 || !document.querySelector('.presentation-chat-card') || !image?.complete || !image.naturalWidth){setTimeout(ready,20);return}
          document.documentElement.classList.toggle('contrast-light',${theme === 'light'});
          requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timeout);resolve({
            rows:Array.from(document.querySelectorAll('[data-case]')).map(row=>({
              id:row.dataset.case,text:row.querySelector('.tline')?.textContent ?? null,
              cardText:row.querySelector('.presentation-chat-card')?.textContent ?? null,
              cardTimed:!!row.querySelector('.presentation-chat-card .tool-writing-time,.presentation-chat-card .tool-exec-time'),
              fileText:row.querySelector('.filecard')?.textContent ?? null,
              fileTimed:!!row.querySelector('.filecard .tool-writing-time,.filecard .tool-exec-time'),
              imageWidth:row.querySelector('.imgcard-img')?.naturalWidth ?? null,
              download:row.querySelector('a.filecard,a.fdl')?.getAttribute('download') ?? null,
              writing:row.querySelector('.tool-writing-time')?.textContent ?? null,
              statusIcon:row.querySelector('.tool-running-status')?.getAttribute('data-testid') ?? null,
              statusTitle:row.querySelector('[aria-label="executing tool call"]')?.title ?? null,
              writingStatus:!!row.querySelector('.tool-writing-status'),
              finishedDot:!!row.querySelector('.tooldot[data-testid="FiberManualRecordIcon"]')})),
            background:getComputedStyle(document.body).backgroundColor})}))
        };ready()})`)
      const row = id => state.rows.find(r => r.id === id)
      const expectedIcon = version === 'before' ? 'PlayArrowIcon' : 'ArrowForwardIcon'
      const unknown = ['unknown-muse', 'unknown-codex'].every(id => version === 'before'
        ? /—/.test(row(id).writing || '') : row(id).writing === null && !/—/.test(row(id).text))
      const semantics = unknown && /784 ms/.test(row('unknown-muse').text) && /200 ms/.test(row('unknown-codex').text)
        && /1\.2s/.test(row('known').writing || '') && /200 ms/.test(row('known').text) && row('known').finishedDot
        && row('running').statusIcon === expectedIcon && row('running').statusTitle === 'Executing tool call'
        && row('running').writing === null && /1s/.test(row('running').text)
        && row('writing').writingStatus && /1s/.test(row('writing').writing || '')
        && (version === 'before' ? row('presentation').text === null && row('presentation').cardTimed
          : /orgtree_present/.test(row('presentation').text || '') && /1\.2s/.test(row('presentation').text || '')
            && /31 ms/.test(row('presentation').text || '') && row('presentation').cardText === 'Verification report' && !row('presentation').cardTimed)
        && ['sentfile','sentimage'].every(id=>version==='before'?row(id).text===null&&row(id).fileTimed
          : /orgtree_send_file/.test(row(id).text||'') && /1\.2s/.test(row(id).text||'') && /31 ms/.test(row(id).text||'') && !row(id).fileTimed)
        && row('sentfile').download==='report.txt' && /2 KB/.test(row('sentfile').fileText||'') && /Exported report/.test(row('sentfile').fileText||'')
        && row('sentimage').download==='shot.png' && /190 KB/.test(row('sentimage').fileText||'') && row('sentimage').imageWidth===320
      const expected = state.background.match(/\d+/g).slice(0,3).map(Number)
      const attempts = []
      let frame, captured, matched = false
      for (let attempt=0;attempt<3;attempt++) {
        frame = await new Promise((resolve,reject) => {
          const timeout=setTimeout(()=>reject(new Error('paint timeout')),3000)
          win.webContents.once('paint',(_event,_dirty,image)=>{clearTimeout(timeout);resolve(image)})
          win.webContents.invalidate()
        })
        const bitmap = frame.toBitmap()
        captured = [bitmap[2],bitmap[1],bitmap[0]]
        attempts.push(captured)
        if (captured.every((value,i)=>Math.abs(value-expected[i])<=6)) { matched=true;break }
      }
      fs.writeFileSync(path.join(evidence, `${version}-${theme}.png`), frame.toPNG())
      receipts.push({version,theme,...state,expected,captured,attempts,matched,semantics})
      fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:false,receipts},null,2))
      if (!semantics || !matched) throw new Error('tool chip semantics or painted theme mismatch')
    }
    fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify({passed:true,receipts},null,2))
  } finally { win.destroy() }
}).then(()=>app.exit(0),error=>{fs.writeFileSync(path.join(evidence,'error.txt'),String(error.stack||error));app.exit(1)})
