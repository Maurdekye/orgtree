const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {app,BrowserWindow,net,clipboard,nativeImage}=require('electron'),out=process.env.MEDIA_OUT;
clipboard.readText=()=>'';clipboard.writeText=()=>{};clipboard.clear=()=>{};
app.disableHardwareAcceleration();app.commandLine.appendSwitch('mute-audio');app.setPath('userData',out+'/user-data');app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let win;const requests=[];
 try{
  win=new BrowserWindow({show:false,width:1000,height:1400,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const wc=win.webContents,s=wc.session;wc.setAudioMuted(true);
  // the grants main/windows.ts configureEngineSession gives a trusted app window: a video's fullscreen button, and nothing else (USER 2026-10-30 md731a537e304)
  s.setPermissionRequestHandler((_,permission,cb)=>cb(permission==='fullscreen'));s.setPermissionCheckHandler(()=>false);
  s.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}));wc.setWindowOpenHandler(()=>({action:'deny'}));
  const wav=Buffer.alloc(44+48000*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
  for(let i=0;i<48000;i++)wav.writeInt16LE(Math.round(800*Math.sin(2*Math.PI*220*i/48000)),44+i*2);
  let video=Buffer.alloc(0);
  const pixels=Buffer.alloc(280*140*4);
  for(let y=0;y<140;y++)for(let x=0;x<280;x++){const i=(y*280+x)*4;pixels[i]=100+x/4;pixels[i+1]=70+y/2;pixels[i+2]=45;pixels[i+3]=255;}
  const png=nativeImage.createFromBitmap(pixels,{width:280,height:140}).toPNG();
  await s.protocol.handle('file',async request=>{
   const url=new URL(request.url);
   if(url.pathname.includes('/api/orgs/synthetic/nodes/agent/file')){
    const name=url.searchParams.get('path');requests.push({name,media:url.searchParams.get('media')});
    const body=name==='clip.webm'?video:name==='tone.wav'?wav:png;
    return new Response(body,{headers:{'Content-Type':name==='clip.webm'?'video/webm':name==='tone.wav'?'audio/wav':'image/png','Content-Length':String(body.length)}});
   }
   const file=decodeURIComponent(url.pathname).replace(/^\//,'');
   if(!path.resolve(file).toLowerCase().startsWith(path.resolve(out).toLowerCase()+path.sep))return new Response('',{status:403});
   return net.fetch(request.url,{bypassCustomProtocolHandlers:true});
  });
  await win.loadURL('about:blank');
  const pid=wc.getOSProcessId();
  const session=spawnSync('powershell',['-NoProfile','-Command',`(Get-Process -Id ${pid}).SessionId`],{encoding:'utf8',windowsHide:true});
  if(pid<=0||session.status!==0||Number(session.stdout.trim())!==0)throw Error('Fixture renderer is not in Session0');
  wc.debugger.attach('1.3');
  const evaluate=async expression=>{const r=await wc.debugger.sendCommand('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const encoded=await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const g=c.getContext('2d');const stream=c.captureStream(8),rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];rec.ondataavailable=e=>chunks.push(e.data);const done=new Promise(r=>rec.onstop=r);rec.start();for(let i=0;i<5;i++){g.fillStyle='#204857';g.fillRect(0,0,320,180);g.fillStyle='#d4f0ff';g.font='24px sans-serif';g.fillText('Synthetic video',60,95);await new Promise(r=>setTimeout(r,125));}rec.stop();await done;stream.getTracks().forEach(t=>t.stop());const b=await new Blob(chunks).arrayBuffer();return btoa(String.fromCharCode(...new Uint8Array(b)));})()`);
  video=Buffer.from(encoded,'base64');fs.writeFileSync(out+'/synthetic.webm',video);fs.writeFileSync(out+'/synthetic.wav',wav);
  // clipboard and native copy paths are dead from the first script of the page, before any fixture code runs
  await wc.debugger.sendCommand('Page.enable');
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>'',writeText:async()=>{throw Error('blocked')},read:async()=>[],write:async()=>{throw Error('blocked')}}});document.execCommand=()=>false;`});
  await win.loadFile(out+'/index.html');
  await evaluate(`Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>'',writeText:async()=>{throw Error('blocked')}}});true`);
  if(!await evaluate(`new Promise(r=>{const t=Date.now();(function p(){if(window.mediaReady||Date.now()-t>6000)r(!!window.mediaReady);else setTimeout(p,40)})()})`))throw Error('fixture page did not start');
  const checks=[];const check=(name,ok)=>checks.push({name,ok:!!ok});
  // USER 2026-10-30 m478dfd75cf44: the video opens on render, paused; audio opens on render too since 2026-11-10 (m3ef1104c77c6)
  const open=await evaluate(`(async()=>{const v=document.querySelector('video');await new Promise(r=>{const t=Date.now();(function p(){if(v.readyState>=2||Date.now()-t>6000)r();else setTimeout(p,50)})()});
    const c=document.createElement('canvas');c.width=v.videoWidth||1;c.height=v.videoHeight||1;let px=null;try{const g=c.getContext('2d');g.drawImage(v,0,0);px=[...g.getImageData(4,4,1,1).data]}catch(e){px=String(e)}
    const r=v.getBoundingClientRect();return{readyState:v.readyState,paused:v.paused,currentTime:v.currentTime,autoplay:v.autoplay,hidden:v.hidden,controls:v.controls,preload:v.getAttribute('preload'),src:v.getAttribute('src'),videoWidth:v.videoWidth,videoHeight:v.videoHeight,width:r.width,height:r.height,pixel:px,playButtons:document.querySelectorAll('.media-play').length,audioWithSrc:document.querySelectorAll('audio[src]').length}})()`);
  check('the video opens on render, paused at 0, with preload=metadata and no autoplay',open.readyState>=2&&open.paused&&open.currentTime===0&&!open.autoplay&&!open.hidden&&open.controls&&open.preload==='metadata'&&open.videoWidth>0);
  check('its first frame is decoded (the synthetic background colour, sampled from the video)',Array.isArray(open.pixel)&&Math.abs(open.pixel[0]-32)<=24&&Math.abs(open.pixel[1]-72)<=24&&Math.abs(open.pixel[2]-87)<=24);
  check('the video asked for its file on render, by the authorized route with the media flag',requests.some(r=>r.name==='clip.webm')&&requests.filter(r=>r.name==='clip.webm').every(r=>r.media==='true'));
  check('the audio cards open on render like the video (USER 2026-11-10 m3ef1104c77c6): a source and a visible player each, no Play button',requests.some(r=>r.name==='tone.wav')&&open.audioWithSrc===2&&open.playButtons===0);
  await evaluate(`(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);wc.invalidate();await new Promise(r=>setTimeout(r,300));
  fs.writeFileSync(out+'/media-open.png',(await wc.capturePage()).toPNG());
  // the video's own fullscreen button is element.requestFullscreen(); the card must not release it while it fills the screen
  const full=await evaluate(`(async()=>{const v=document.querySelector('video');window.__io=[];new IntersectionObserver(es=>es.forEach(e=>window.__io.push(e.isIntersecting))).observe(v.closest('.mediacard'));
    try{await v.requestFullscreen()}catch(e){return{ok:false,error:String(e)}}
    await new Promise(r=>setTimeout(r,700));const r=v.getBoundingClientRect();
    return{ok:true,element:document.fullscreenElement&&document.fullscreenElement.tagName,src:v.getAttribute('src'),readyState:v.readyState,paused:v.paused,hidden:v.hidden,observerSaw:window.__io.slice(),width:r.width,height:r.height,innerWidth:innerWidth,innerHeight:innerHeight}})()`);
  check('the video can be maximized: requestFullscreen resolves and the video is the fullscreen element',full.ok&&full.element==='VIDEO');
  check('in fullscreen it keeps its source, stays paused and visible',full.ok&&!!full.src&&full.readyState>=2&&full.paused&&!full.hidden);
  check('in fullscreen it fills the window',full.ok&&Math.abs(full.width-full.innerWidth)<=2&&Math.abs(full.height-full.innerHeight)<=2);
  await new Promise(r=>setTimeout(r,200));wc.invalidate();await new Promise(r=>setTimeout(r,300));
  fs.writeFileSync(out+'/media-fullscreen.png',(await wc.capturePage()).toPNG());
  const left=await evaluate(`(async()=>{await document.exitFullscreen();await new Promise(r=>setTimeout(r,500));const v=document.querySelector('video');return{out:document.fullscreenElement===null,src:v.getAttribute('src'),readyState:v.readyState,hidden:v.hidden}})()`);
  check('leaving fullscreen returns to the card with the video still open',left.out&&!!left.src&&left.readyState>=2&&!left.hidden);
  const state=await evaluate(`(async()=>{const buttons=[...document.querySelectorAll('.media-play')];for(const b of buttons)b.click();await new Promise(r=>setTimeout(r,250));const media=[...document.querySelectorAll('video,audio')];await Promise.all(media.map(async m=>{await m.play();m.pause();}));return media.map(m=>({kind:m.tagName,width:m.getBoundingClientRect().width,height:m.getBoundingClientRect().height,ready:m.readyState,error:!!m.error,src:m.getAttribute('src'),controls:m.controls}));})()`);
  check('actual video/audio decoders load generated media (the chat cards and the Files list rows)',state.length>=3&&state.every(m=>m.ready>=2&&!m.error));
  check('visible native controls fit card geometry',state.every(m=>m.width>0&&m.width<=440&&m.height>0&&m.height<=320&&m.controls));
  check('player requests use authorized-route media flag',requests.filter(r=>r.name!=='image.png').every(r=>r.media==='true'));
  check('oversized video stays download-only',await evaluate(`document.querySelectorAll('video').length===1&&document.body.textContent.includes('256 MiB')`));
  await evaluate(`(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);wc.invalidate();await new Promise(r=>setTimeout(r,250));
  fs.writeFileSync(out+'/media-cards.png',(await wc.capturePage()).toPNG());
  const passed=checks.every(c=>c.ok);fs.writeFileSync(out+'/verdict.json',JSON.stringify({passed,checks,media:state,open,fullscreen:full,left,isolation:{pid,session:0,muted:wc.isAudioMuted(),clipboard:'empty stub/permissions denied except fullscreen (the trusted-window grant)',network:'HTTP blocked; synthetic file responses only',input:'CDP owned window'}},null,2));win.destroy();win=null;app.exit(passed?0:1);
 }catch(e){fs.writeFileSync(out+'/capture-error.txt',String(e.stack));if(win&&!win.isDestroyed())win.destroy();app.exit(2);}
});
