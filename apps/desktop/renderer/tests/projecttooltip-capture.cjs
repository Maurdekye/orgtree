const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const out=process.env.RETIRED_HEADER_OUT,deps='E:/Libraries/Desktop/orgtree/node_modules'
if(!/^C:[\\/]orgtree-build[\\/]taskbar-orgs-sol[\\/]/i.test(out||''))throw Error('own output required')
fs.mkdirSync(out,{recursive:true})
require(path.join(deps,'esbuild')).buildSync({entryPoints:['apps/desktop/renderer/tests/projecttooltip-visual.tsx'],bundle:true,format:'esm',platform:'browser',outfile:out+'/fixture.js',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'}})
fs.writeFileSync(out+'/styles.css',['styles.css','shell.css'].map(p=>fs.readFileSync('apps/desktop/renderer/src/'+p,'utf8')).join('\n'))
fs.writeFileSync(out+'/fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="fixture.js"></script>')
for(const key of ['userData','sessionData','logs','crashDumps']){fs.mkdirSync(out+'/'+key,{recursive:true});app.setPath(key,out+'/'+key)}app.disableHardwareAcceleration()
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1000,height:700,useContentSize:true,show:false,paintWhenInitiallyHidden:true,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}}),records=[]
 const settle='new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,120))))'
 try{
  win.webContents.session.webRequest.onBeforeRequest((d,done)=>done({cancel:!/^(file:|data:)/.test(d.url)}));await win.loadFile(out+'/fixture.html')
  await new Promise(r=>setTimeout(r,250))
  const facts='Project · slots 0/2 held · listeners 3 · mail: 3 listeners · # test project'
  for(const theme of ['dark','light'])for(const [label,selector,nameFirst]of [['card','.sq.project:not(.mini)',false],['name','.sq.project:not(.mini) .name',false],['icon','.project-mark',true],['far','.project-mini',false],['inline','.ref-ready',false]]){
   const seen=await win.webContents.executeJavaScript(`(async()=>{document.documentElement.classList.toggle('contrast-light',${theme==='light'});const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('target absent');el.dispatchEvent(new MouseEvent('pointerover',{bubbles:true}));document.querySelector('#inspected-title').textContent=el.title;await ${settle};return{title:el.title,badges:[...document.querySelectorAll('.project-header-badges > span')].map(x=>x.textContent)}})()`)
   assert.equal(seen.title,(nameFirst?'test-project\n':'')+facts);assert.deepEqual(seen.badges,['0/2 held','listeners 3','3 listeners']);records.push({theme,label,...seen})
   if(['card','icon'].includes(label)){await win.webContents.executeJavaScript(settle);const frame=await win.webContents.capturePage();assert.equal(frame.isEmpty(),false);fs.writeFileSync(out+`/${label}-${theme}.png`,frame.toPNG())}
  }
  fs.writeFileSync(out+'/titles.json',JSON.stringify(records,null,2))
 }finally{win.destroy()}
}).then(()=>app.exit(0),e=>{console.error(e.stack||e);app.exit(1)})
