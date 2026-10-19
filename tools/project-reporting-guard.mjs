// Scoped source guard for audited reporting entry points. Structural tree walks,
// project features and the signed physical-parent peer-mail exception stay legal.
// Run: node tools/project-reporting-guard.mjs --self-test
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const sourceRoot=path.join(root,'engine/rs/orgtree-engine/src')
// Keep boundaries explicit: adding a new reporting entry point requires an audit
// and a contract here. This is not a Rust parser or a substitute for rig proofs.
const contracts=[
  ['domain/runtime_notices.rs','end_turn','ot.live_superior_of'],
  ['domain/runtime_notices.rs','launch_failed','ot.live_superior_of'],
  ['runtime/recovery.rs','who','ot.live_superior_of'],
  ['domain/lifecycle.rs','seat','ot.superior_of'],
  ['domain/lifecycle.rs','siblings','ot.reports_of'],
  ['tools/mod.rs','me','ot.agent_reporting'],
  ['runtime/watchdogs/events.rs','identity','ot.agent_reporting'],
  ['domain/audiences.rs','live','ot.superior_of'],
  ['domain/audiences.rs','project_manager','ot.superior_of'],
  ['domain/asks.rs','asker','ot.superior_of'],
  ['domain/docket.rs','handoff','ot.superior_of'],
  ['runtime/convo.rs','superior_hint','ot.superior_of'],
  ['domain/ops.rs','agent_superior','ot.superior_of'],
]
const sources=new Map(contracts.map(([file])=>[file,fs.readFileSync(path.join(sourceRoot,file),'utf8')]))
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
function body(source,name) {
  const matches=[...source.matchAll(new RegExp(`^([ \\t]*)(?:pub(?:\\([^)]*\\))? )?(?:async )?fn ${escape(name)}\\(`,'gm'))]
  assert.equal(matches.length,1,`${name}: expected exactly one audited function`)
  const start=matches[0].index, tail=source.slice(start)
  // The audited functions use a closing brace at their declaration indentation.
  // Refuse an unrecognised boundary instead of silently checking an empty slice.
  const end=tail.match(new RegExp(`^${escape(matches[0][1])}\\}`,'m'))
  assert(end,`${name}: missing function boundary`)
  const text=tail.slice(0,end.index+end[0].length)
  assert(text.includes('{'),`${name}: missing function body`)
  return {start,text}
}
function violations(contract,source) {
  const [file,name,relation]=contract
  const {text}=body(source,name), errors=[]
  if(/\bparent_id\b|\.\s*parent\b/.test(text)) errors.push(`${file}::${name}: raw placement parent in a reporting decision`)
  if(!text.includes(relation)) errors.push(`${file}::${name}: missing reporting relation ${relation}`)
  return errors
}
let errors=[]
for(const contract of contracts) {
  try { errors.push(...violations(contract,sources.get(contract[0]))) }
  catch(e) {errors.push(`${contract[0]}::${contract[1]}: ${e.message}`)}
}
let rejected=0
if(process.argv.includes('--self-test')) {
  for(const contract of contracts) {
    const source=sources.get(contract[0]), slice=body(source,contract[1])
    const replace=text=>source.slice(0,slice.start)+text+source.slice(slice.start+slice.text.length)
    const raw=replace(slice.text.replace('{','{\n    let _wrong_superior = row.parent_id;'))
    assert(violations(contract,raw).some(s=>s.includes('raw placement')),`${contract[1]}: raw-parent mutant escaped`)
    rejected++
    const missing=replace(slice.text.replaceAll(contract[2],'unapproved_relation'))
    assert(violations(contract,missing).some(s=>s.includes('missing reporting')),`${contract[1]}: missing-helper mutant escaped`)
    rejected++
  }
  const [contract]=contracts
  assert.deepEqual(violations(contract,sources.get(contract[0])+'\nfn structural_placement() { let p = row.parent_id; }\n'),[],
    'the guard must not ban structural placement outside its audited boundaries')
  assert.throws(()=>body('fn renamed() {}','missing'),'renamed/removed functions must fail closed')
}
console.log(JSON.stringify({guard:'project-reporting',contracts:contracts.length,rejected_mutants:rejected,passed:errors.length===0,errors},null,2))
process.exitCode=errors.length?1:0
