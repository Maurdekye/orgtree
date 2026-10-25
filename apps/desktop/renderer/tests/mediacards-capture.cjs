const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {app,BrowserWindow,net,clipboard,nativeImage}=require('electron'),out=process.env.MEDIA_OUT;
clipboard.readText=()=>'';clipboard.writeText=()=>{};clipboard.clear=()=>{};
app.disableHardwareAcceleration();app.setPath('userData',out+'/user-data');app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{let win;const requests=[];
 try{
  win=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const wc=win.webContents,s=wc.session;
  s.setPermissionRequestHandler((_,__,cb)=>cb(false));s.setPermissionCheckHandler(()=>false);
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
  await win.loadFile(out+'/index.html');
  const pid=wc.getOSProcessId();
  const session=spawnSync('powershell',['-NoProfile','-Command',`(Get-Process -Id ${pid}).SessionId`],{encoding:'utf8',windowsHide:true});
  if(pid<=0||session.status!==0||Number(session.stdout.trim())!==0)throw Error('Fixture renderer is not in Session0');
  wc.debugger.attach('1.3');
  const evaluate=async expression=>{const r=await wc.debugger.sendCommand('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await evaluate(`Object.defineProperty(navigator,'clipboard',{value:{readText:async()=>'',writeText:async()=>{throw Error('blocked')}}});true`);
  const encoded=await evaluate(`(async()=>{const c=document.createElement('canvas');c.width=320;c.height=180;const g=c.getContext('2d');const stream=c.captureStream(8),rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];rec.ondataavailable=e=>chunks.push(e.data);const done=new Promise(r=>rec.onstop=r);rec.start();for(let i=0;i<5;i++){g.fillStyle='#204857';g.fillRect(0,0,320,180);g.fillStyle='#d4f0ff';g.font='24px sans-serif';g.fillText('Synthetic video',60,95);await new Promise(r=>setTimeout(r,125));}rec.stop();await done;stream.getTracks().forEach(t=>t.stop());const b=await new Blob(chunks).arrayBuffer();return btoa(String.fromCharCode(...new Uint8Array(b)));})()`);
  video=Buffer.from(encoded,'base64');fs.writeFileSync(out+'/synthetic.webm',video);fs.writeFileSync(out+'/synthetic.wav',wav);
  const checks=[];const check=(name,ok)=>checks.push({name,ok:!!ok});
  check('no video/audio requests before Play',requests.every(r=>r.name==='image.png'));
  const state=await evaluate(`(async()=>{const buttons=[...document.querySelectorAll('.media-play')];for(const b of buttons)b.click();await new Promise(r=>setTimeout(r,250));const media=[...document.querySelectorAll('video,audio')];await Promise.all(media.map(async m=>{await m.play();m.pause();}));return media.map(m=>({kind:m.tagName,width:m.getBoundingClientRect().width,height:m.getBoundingClientRect().height,ready:m.readyState,error:!!m.error,src:m.getAttribute('src'),controls:m.controls}));})()`);
  check('actual video/audio decoders load generated media',state.length===3&&state.every(m=>m.ready>=2&&!m.error));
  check('visible native controls fit card geometry',state.every(m=>m.width>0&&m.width<=440&&m.height>0&&m.height<=320&&m.controls));
  check('player requests use authorized-route media flag',requests.filter(r=>r.name!=='image.png').every(r=>r.media==='true'));
  check('oversized video stays download-only',await evaluate(`document.querySelectorAll('video').length===1&&document.body.textContent.includes('256 MiB')`));
  await evaluate(`(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);wc.invalidate();await new Promise(r=>setTimeout(r,250));
  fs.writeFileSync(out+'/media-cards.png',(await wc.capturePage()).toPNG());
  const passed=checks.every(c=>c.ok);fs.writeFileSync(out+'/verdict.json',JSON.stringify({passed,checks,media:state,isolation:{pid,session:0,clipboard:'empty stub/permissions denied',network:'HTTP blocked; synthetic file responses only',input:'CDP owned window'}},null,2));win.destroy();win=null;app.exit(passed?0:1);
 }catch(e){fs.writeFileSync(out+'/capture-error.txt',String(e.stack));if(win&&!win.isDestroyed())win.destroy();app.exit(2);}
});
