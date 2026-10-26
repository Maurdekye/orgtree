// Replay the actual read-only picker driver and its three unchanged proof guards.
// No browser, engine, auth or database; full24-check runtime stays with the rig.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo=fileURLToPath(new URL('../../../',import.meta.url))
const read=file=>(process.env.ORG_PICKER_FIXTURE_REF
  ? execFileSync('git',['show',`${process.env.ORG_PICKER_FIXTURE_REF}:${file}`],{cwd:repo,encoding:'utf8'})
  :fs.readFileSync(path.join(repo,file),'utf8')).replaceAll('\r\n','\n')
const source=read('tools/rig/desktop/org-accounts-picker.cjs')
const proof=read('tools/rig/proofs/org-accounts.mjs')
const begin=proof.indexOf('    const k = pk.value ?? {}')
const last="    p.note('picker screenshots', pk.out)"
const end=proof.indexOf(last,begin)
assert(begin>=0 && end>begin)
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
const execute=new AsyncFunction('pk','B','p',proof.slice(begin,end+last.length))
const SEL='select[aria-label="Default provider account for new hires"]'
const primary={value:'claude/primary',innerText:'Primary (not used by this org)',disabled:true}
const second={value:'claude-5',innerText:'rig-b@example.invalid',disabled:false}

async function drive({present=true,options=[primary,second],shown=primary.innerText,warnings=[]}={}) {
  const seen={shots:[],waits:[],sleeps:[]}
  const select={options,value:primary.value,selectedOptions:[{innerText:shown}],title:shown,
    closest:()=>({scrollIntoView(){}})}
  const document={querySelector:selector=>present && selector===SEL ? select:null}
  const context=vm.createContext({module:{exports:{}},document})
  vm.runInContext(source,context)
  const page={consoleErrors:warnings,
    async goto(route){assert.equal(route,'/o/fixture-org')},async rightClick(){},
    async click(target){assert(target==='#org-settings-tab-hiredefaults' || target?.text==='Org settings','the driver must remain read-only')},
    async waitFor(target){
      seen.waits.push(target)
      if(typeof target==='string' && target.startsWith('select[') && !document.querySelector(target))throw new Error(`unavailable selector: ${target}`)
      return true
    },
    async sleep(ms){seen.sleeps.push(ms)},
    async eval(fn,...args){return vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`,context)},
    async screenshot(name){seen.shots.push(name)},
  }
  const value=await context.module.exports(page,{args:{org:'fixture-org'}})
  return {value:JSON.parse(JSON.stringify(value)),seen}
}
async function checks(value,ok=true) {
  const rows=[]
  await execute({ok,value,out:'.'},second.value,{check:(what,pass,detail)=>rows.push({what,ok:!!pass,detail}),note(){}})
  assert.equal(rows.length,3)
  return rows
}

test('actual driver reads B and the muted saved default through the current Sentence-case selector',async()=>{
  const {value,seen}=await drive()
  assert.deepEqual(value.options,[{value:primary.value,text:primary.innerText,disabled:true},{value:second.value,text:second.innerText,disabled:false}])
  assert.equal(value.value,primary.value);assert.equal(value.title,primary.innerText)
  assert.deepEqual(seen.shots,['picker']);assert.deepEqual(seen.sleeps,[2500]);assert(seen.waits.includes(SEL))
  assert((await checks(value)).every(c=>c.ok))
})
test('an absent select still rejects the actual driver',async()=>{
  await assert.rejects(drive({present:false}),/unavailable selector/)
})
test('console warnings remain raw and fail the unchanged picker-console predicate',async()=>{
  const warning='Synthetic baseline console warning'
  const {value}=await drive({warnings:[warning]})
  assert.deepEqual(value.consoleErrors,[warning])
  const got=await checks(value)
  assert.equal(got[0].ok,true);assert.equal(got[1].ok,true);assert.equal(got[2].ok,false)
  assert.deepEqual(got[2].detail,[warning])
})
test('no B option still fails the original allowed-choice guard',async()=>{
  const {value}=await drive({options:[primary]})
  const got=await checks(value)
  assert.equal(got[0].ok,false);assert.equal(got[1].ok,true)
})
test('an enabled, unmuted primary fails both original picker guards',async()=>{
  const {value}=await drive({options:[{...primary,disabled:false},second],shown:'Primary'})
  const got=await checks(value)
  assert.equal(got[0].ok,false);assert.equal(got[1].ok,false)
})
test('failed-driver empty data cannot pass either picker guard',async()=>{
  const got=await checks(undefined,false)
  assert.equal(got[0].ok,false);assert.equal(got[1].ok,false)
  // The original console fallback is retained; this is not a no-warning claim.
})
