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
  ['domain/runtime_notices.rs','deep_reach_batch_tx','ot.superior_of'],
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
function rustFiles(dir) {
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?rustFiles(path.join(dir,e.name)):
    e.isFile()&&e.name.endsWith('.rs')?[path.join(dir,e.name)]:[])
}
const sources=new Map(rustFiles(sourceRoot).map(file=>[path.relative(sourceRoot,file).replaceAll('\\','/'),fs.readFileSync(file,'utf8')]))
// Structural modules only. These sites describe placement/folders or chart
// roots, never authority. A new exception requires a source audit and reason.
const structural=new Map([
  ['domain/projects.rs','Project folder traversal follows physical ancestry.'],
  ['domain/template_wire.rs','Template wire helpers describe physical layout placement, never reporting authority.'],
  ['domain/template_scale_http_tests.rs','Audience-parity fixture attaches physical template roots beneath a project.'],
  ['feed/compute.rs','Archived chart roots preserve physical tree placement.'],
  ['feed/groups.rs','Organization chart grouping counts physical roots.'],
])
function rawDecisions(file,source) {
  if(structural.has(file)) return []
  const patterns=/\bparent_id\s+IS\s+NULL\b|\.\s*parent\s*\.\s*is_none\s*\(\s*\)|\bJOIN[^\r\n"]*=\s*a\.parent_id\b/gi
  return [...source.matchAll(patterns)].map(m=>`${file}:${source.slice(0,m.index).split('\n').length}: raw parent decision outside structural allowlist: ${m[0]}`)
}
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
for(const [file,source] of sources) errors.push(...rawDecisions(file,source))
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
  for(const source of ['SELECT id FROM ot.agents WHERE parent_id IS NULL','if a.parent.is_none() {}','JOIN ot.agents p ON p.id = a.parent_id']) {
    assert.equal(rawDecisions('runtime/new_reporting.rs',source).length,1,'new reporting code must not bypass the guard')
    rejected++
  }
  assert.deepEqual(rawDecisions('domain/projects.rs','SELECT id FROM ot.agents WHERE parent_id IS NULL'),[])
}
console.log(JSON.stringify({guard:'project-reporting',contracts:contracts.length,scanned_files:sources.size,structural_exceptions:[...structural],rejected_mutants:rejected,passed:errors.length===0,errors},null,2))
process.exitCode=errors.length?1:0
