const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.QUICK_WIDTH_CAPTURE_ROOT
assert.match(out||'',/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i)
app.setPath('userData',path.join(out,'user-data'));app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
  const win=new BrowserWindow({width:980,height:650,show:false,useContentSize:true,
    webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}})
  try {
    await win.loadFile(path.join(out,'fixture.html'))
    win.webContents.setZoomFactor(.7)
    const result=await win.webContents.executeJavaScript(`(async()=>{
      const frames=n=>new Promise(resolve=>{const step=()=>--n?requestAnimationFrame(step):resolve();requestAnimationFrame(step)});
      const results=[];
      for(const [width,changed] of [[1280,false],[1024,false],[800,false],[640,false],[512,false],[1280,false],[1024,true],[1280,true]]) {
        window.quickWidthFixture(width,changed);await frames(20);
        const rows=[...document.querySelectorAll('[data-case]')],samples=rows.map(()=>[]);
        for(let i=0;i<80;i++){await frames(1);rows.forEach((row,j)=>{const q=row.querySelector('.shell-header-quick,.shell-statusbar-quick');samples[j].push(q.getBoundingClientRect().width)})}
        results.push(...rows.map((row,i)=>({width,changed,case:row.dataset.case,floor:parseFloat(getComputedStyle(row.querySelector('.shell-header-quick,.shell-statusbar-quick')).minWidth),min:Math.min(...samples[i]),max:Math.max(...samples[i]),tail:samples[i].slice(-12),samples:samples[i]})));
      }
      return results;
    })()`)
    fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(result,null,2))
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,120))))')
    fs.writeFileSync(path.join(out,'quickwidth.png'),(await win.webContents.capturePage()).toPNG())
    const unstable=result.filter(row=>row.max-row.min>.1)
    const historyDependent=result.filter((row,i)=>row.width===1280&&!row.changed&&i>=20&&Math.abs(row.min-result.find(first=>first.width===1280&&!first.changed&&first.case===row.case).min)>.1)
    console.log(JSON.stringify({cases:result.length,unstable:unstable.map(({samples,...row})=>row),historyDependent:historyDependent.map(({samples,...row})=>row)}))
    assert.equal(result.length,32,'every header/footer configuration must be sampled')
    assert.equal(unstable.length,0,'Quick chat must settle, not alternate widths each frame')
    assert.equal(historyDependent.length,0,'The same width and controls must produce the same layout after a narrow resize')
    assert.ok(result.every(row=>row.min>=row.floor-.1),'Quick chat keeps its responsive CSS floor (160px narrow, 200px otherwise)')
    assert.ok(result.find(row=>row.width===1280&&!row.changed&&row.case==='header-0').min>
      result.find(row=>row.width===1024&&!row.changed&&row.case==='header-0').min,'Quick chat grows again when the window widens')
  }finally{win.destroy()}
}).then(()=>app.exit(0),error=>{console.error(error.stack||error);app.exit(1)})
