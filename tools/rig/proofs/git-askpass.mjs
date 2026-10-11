// Native adapter protocol/precedence proof, synthetic values only. No Git config
// is written outside this isolated evidence directory; no actual credential store.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { Proof } from '../proof.mjs'
const p=new Proof('git-askpass')
const engine=path.join(process.env.CARGO_TARGET_DIR,'debug','orgtree-engine.exe')
const alias=path.join(p.dir,'orgtree-git-askpass.exe');fs.copyFileSync(engine,alias)
const requests=[]
const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{
 const v=JSON.parse(body);requests.push(v)
 if(v.host==='missing.example'){res.writeHead(503);res.end('test bridge miss');return}
 res.end('username=rig-user\npassword=rig-password\n\n')
})})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const env={...process.env,GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_SYSTEM:'NUL',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',
 GIT_ASKPASS:alias,ORGTREE_CREDENTIAL_AUTH:'synthetic',ORGTREE_CREDENTIAL_AGENT:'1',ORGTREE_CREDENTIAL_URL:`http://127.0.0.1:${server.address().port}/api/agent-credential`}
for(const k of Object.keys(env))if(/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(k)||k==='ORGTREE_ORIGINAL_GIT_ASKPASS'||k==='SSH_ASKPASS')delete env[k]
const run=(exe,args,e=env,input='')=>new Promise((resolve,reject)=>{const c=spawn(exe,args,{cwd:p.dir,env:e,windowsHide:true});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',code=>resolve({code,out,err}));c.stdin.on('error',()=>{});c.stdin.end(input)})
try {
 let r=await run(alias,["Username for 'https://github.com': "])
 p.check('native username result',r.code===0&&r.out.trim()==='rig-user')
 r=await run(alias,["Password for 'https://a%40b%3Ac@github.com:443/org/a%252Fb%20c': "])
 let got=requests.at(-1)
 p.check('encoded username, port and literal-percent path round-trip',r.code===0&&r.out.trim()==='rig-password'&&got.host==='github.com:443'&&got.username==='a@b:c'&&got.path==='org/a%2Fb c',got)
 const fallback=path.join(p.dir,'fallback.cmd'),core=path.join(p.dir,'core.cmd')
 fs.writeFileSync(fallback,'@echo off\r\necho original-fallback\r\n');fs.writeFileSync(core,'@echo off\r\necho core-fallback\r\n')
 const withCore={...env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.askPass',GIT_CONFIG_VALUE_0:core}
 r=await run(alias,["Password for 'https://missing.example': "],{...withCore,ORGTREE_ORIGINAL_GIT_ASKPASS:fallback})
 p.check('bridge miss uses original GIT_ASKPASS before core.askPass',r.code===0&&r.out.trim()==='original-fallback',r)
 r=await run(alias,["Password for 'https://missing.example': "],withCore)
 p.check('bridge miss uses core.askPass when original env absent',r.code===0&&r.out.trim()==='core-fallback',r)
 const before=requests.length
 r=await run(alias,['Unrecognised prompt'],{...env,ORGTREE_ORIGINAL_GIT_ASKPASS:fallback})
 p.check('unrecognised prompt reaches original without bridge request',r.code===0&&r.out.trim()==='original-fallback'&&requests.length===before,r)
 r=await run(alias,['Unrecognised prompt'],{...withCore,ORGTREE_ORIGINAL_GIT_ASKPASS:''})
 p.check('empty original askpass suppresses core fallback',r.code!==0)
 r=await run(alias,['Unrecognised prompt'],{...env,SSH_ASKPASS:fallback})
 p.check('SSH_ASKPASS is final fallback',r.code===0&&r.out.trim()==='original-fallback')
 const input='protocol=https\nhost=github.com:443\nusername=a@b:c\npath=org/a%2Fb c\n\n'
 r=await run('git',['-c','credential.sanitizePrompt=true','-c','credential.useHttpPath=true','credential','fill'],env,input)
 got=requests.at(-1)
 p.check('real Git prompt parses exact input fields',r.code===0&&got.host==='github.com:443'&&got.username==='a@b:c'&&got.path==='org/a%2Fb c',got)
 const start=requests.length
 r=await run('git',['-c','credential.interactive=false','credential','fill'],env,'protocol=https\nhost=github.com\n\n')
 p.check('interactive=false is respected without a bridge lookup',r.code!==0&&requests.length===start)
 const operations={}
 for(const mode of ['helper','askpass']) {
  const log=path.join(p.dir,mode+'-operations.log').replaceAll('\\','/')
  const logger=`!f() { echo "$1" >> '${log}'; cat > /dev/null; }; f`
  const args=['-c','credential.helper='+logger,'-c','credential.sanitizePrompt=true']
  if(mode==='helper')args.push('-c',`credential.helper=!'${engine.replaceAll('\\','/')}' credential-helper`)
  const e={...env};if(mode==='helper')delete e.GIT_ASKPASS
  const filled=await run('git',[...args,'credential','fill'],e,'protocol=https\nhost=github.com\n\n')
  p.check(mode+': synthetic bridge fill',filled.code===0&&filled.out.includes('password=rig-password'))
  const approved=await run('git',[...args,'credential','approve'],e,filled.out)
  p.check(mode+': synthetic approve',approved.code===0)
  operations[mode]=fs.readFileSync(log,'utf8').trim().split(/\r?\n/)
 }
 p.check('same configured helper receives get/store, no additional token store',JSON.stringify(operations.helper)===JSON.stringify(operations.askpass)&&operations.askpass.join(',')==='get,store',operations)
 p.file('operations.json',operations)
}finally{await new Promise(r=>server.close(r));fs.unlinkSync(alias)}
console.log(JSON.stringify(p.summary()));if(!p.passed)process.exitCode=1
