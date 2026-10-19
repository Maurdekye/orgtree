import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { grantLimits, hireGrantMax } from '../src/canvas/creditgrant'
import { agentSuperior, effectiveReports, isTopLevel, draftOpeningGrant, USER } from '../src/canvas/shared'
import type { CanvasNode, DraftScope } from '../src/canvas/shared'
import { retireAllSubordinates, agentMenuEntries } from '../src/canvas/agentmenu'
import { cascadePreview, DraftScopeModal } from '../src/canvas/modals'
import { EyeDesk } from '../src/canvas/cards'
import { quickChatHire } from '../src/quickchat'
import { quickChatChoices } from '../src/quickchat-availability'
import type { TreePayload } from '../src/types'
import type { StaffingOptions } from '../src/canvas/staffingoptions'

const agent = (id: string, children: CanvasNode[] = [], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, tier: 'sol', state: 'live', seat: 2, grant: 10, free: 5, children,
  scope: { tools: { bash: false, mcp: [] }, add_dirs: [{ path: 'C:/boss', mode: 'ro' }] }, ...extra,
})
const project = (id: string, children: CanvasNode[] = []): CanvasNode => ({id, kind: 'project', tier: 'project', state: 'live', children})
function index(roots: CanvasNode[]) {
  const map = new Map<string, CanvasNode>()
  const walk = (n: CanvasNode, parent: string) => { n.parent = parent; map.set(n.id, n); n.children.forEach(c => walk(c, n.id)) }
  roots.forEach(n => walk(n, USER)); return map
}
const wrapped = (n: CanvasNode) => project('outer', [project('inner', [n]), project('empty')])
const settings = { max_top_grant: 100, default_top_grant: 37, cascade_alloc: true } as TreePayload

test('structural helpers cross projects but retain archived agent superiors', () => {
  const child=agent('child'), boss=agent('boss',[wrapped(child)],{state:'archived'})
  const map=index([boss])
  assert.equal(agentSuperior(child,map)?.id,'boss')
  assert.equal(isTopLevel(child,map),false)
  assert.deepEqual(effectiveReports(boss.children).map(n=>n.id),['child'])
  assert.equal(isTopLevel(boss,map),true)
  assert.equal(isTopLevel({parent:'missing'},map),false)
  const cycle=project('cycle');cycle.parent='cycle';map.set(cycle.id,cycle)
  assert.equal(isTopLevel({parent:'cycle'},map),false)
  assert.equal(agentSuperior({parent:'cycle'},map),undefined)
})
for(const cascade of [false,true]) test(`hire ceiling reserves seat through nested projects, cascade=${cascade}`,()=>{
  const map=index([agent('boss',[project('team',[project('nested')])],{grant:80,free:7})])
  const tree={max_top_grant:100,cascade_hire:cascade}
  assert.equal(hireGrantMax('nested',2,map,tree),cascade?25:5)
  assert.equal(hireGrantMax('boss',2,map,tree),hireGrantMax('nested',2,map,tree))
  const root=index([project('root',[project('nested')])])
  assert.equal(hireGrantMax('nested',2,root,tree),100)
  assert.equal(hireGrantMax('nested',2,root,tree,12),88,'inserted superior carries the anchor stake')
})

for (const cascade of [false, true]) test(`grant ceiling ignores nested project holdings, cascade=${cascade}`, () => {
  const direct = agent('report'), indirect = agent('report')
  const plain = index([agent('boss', [direct], {grant: 80, free: 7})])
  const nested = index([agent('boss', [wrapped(indirect)], {grant: 80, free: 7})])
  assert.deepEqual(grantLimits(direct, plain, {...settings, cascade_alloc: cascade}),
    {min: 5, max: cascade ? 37 : 17, unavailable: false})
  assert.deepEqual(grantLimits(indirect, nested, {...settings, cascade_alloc: cascade}),
    grantLimits(direct, plain, {...settings, cascade_alloc: cascade}))
})

test('root projects preserve top-level credit cap', () => {
  const child = agent('root-agent'), map = index([wrapped(child)])
  assert.deepEqual(grantLimits(child, map, settings), {min: 5, max: 100, unavailable: false})
})
test('broken funding ancestry cannot raise credits', () => {
  const child = agent('lost', [], {parent: 'missing'})
  assert.equal(grantLimits(child, new Map(), settings).unavailable, true)
})
test('root projects inherit the top-level draft grant, agent projects do not', () => {
  const map = index([wrapped(agent('child')), agent('boss', [project('team')])])
  // Third argument is the real tree, required for project placement.
  const opening = draftOpeningGrant as (d: {parent: string | null; tier: string}, n: number, m: Map<string, CanvasNode>) => number
  assert.equal(opening({parent: null, tier:'sol'}, 37, map), 37)
  assert.equal(opening({parent:'inner', tier:'sol'}, 37, map), 37)
  assert.equal(opening({parent:'team', tier:'sol'}, 37, map), 0)
})
test('Quick chat root-project hires omit redundant personal user audience', () => {
  const map = index([wrapped(agent('child')), agent('boss', [project('team')])])
  const hire = quickChatHire as (c: Parameters<typeof quickChatHire>[0], m: Map<string, CanvasNode>) => ReturnType<typeof quickChatHire>
  const request = {message:'synthetic task', name:'hire', tier:'sol', effort:'high', superior:'inner', grant:37}
  assert.equal('audiences' in hire(request, map), false)
  assert.deepEqual(hire({...request, superior:'team', grant:0}, map).audiences, ['user'])
  assert.equal(hire(request, map).parent, 'inner', 'placement survives')
})
test('Quick chat applies top-level default cap even through root projects', () => {
  const row = {tier:'sol',seat:2,efforts:['high'],accounts:[],default_ok:true}
  const map = index([project('root', [project('nested')])])
  const tree = {...settings, default_top_grant:110}
  const options = {tiers:[row]} as StaffingOptions
  assert.equal(quickChatChoices(options, tree, map, null).length, 0)
  assert.equal(quickChatChoices(options, tree, map, 'nested').length, 0)
})
test('retire all subordinates targets first agents through projects and keeps wrappers', async () => {
  const a=agent('a',[agent('grandchild')]), b=agent('b'), boss=agent('boss',[wrapped(a),b,project('vacant')])
  const calls: string[]=[]
  await retireAllSubordinates(boss, async body => { calls.push(String(body.node)); return {} }, () => {})
  assert.deepEqual(calls, ['a','b'])
})
test('empty projects do not create retirement work', async () => {
  const boss=agent('boss',[project('empty',[project('nested')])]), calls: unknown[]=[]
  await retireAllSubordinates(boss, async body => {calls.push(body);return {}}, () => {})
  assert.equal(calls.length, 0)
  const menu=agentMenuEntries(boss, {onInbox:()=>{},onSettings:()=>{},onRetireAsk:()=>{}} as Parameters<typeof agentMenuEntries>[1])
  assert.equal(menu.some(e=>e!=='sep' && e.label==='Dissolve…'), false)
})
test('scope cascade warns about agents, never projects', () => {
  const child=agent('child'), map=index([agent('boss',[wrapped(child)])])
  const result=cascadePreview(map, child.id, {dirs:[{path:'C:/new',mode:'rw'}]})
  assert.deepEqual(result, [{id:'boss',gains:['C:/new rw']}])
  const root=index([wrapped(agent('child'))])
  assert.deepEqual(cascadePreview(root,'child',{dirs:[{path:'C:/new',mode:'rw'}]}), [])
})
test('switchboard lists effective top agents, omits project tabs and protects intrinsic lines', async t => {
  installFetch(new FakeServer())
  const a=agent('top-agent',[],{audiences_held:[USER],audiences_explicit:[USER]})
  const other=agent('audience-agent',[],{audiences_held:[USER],audiences_explicit:[USER]})
  const map=index([wrapped(a),agent('boss',[other])])
  const view=await mountView(<EyeDesk map={map} slug="project-relations" op={async()=>({})} toast={()=>{}} eyeW={800} onMailLink={()=>{}} />, el=>el)
  t.after(()=>view.unmount());await flush(4)
  const tabs=[...view.el.querySelectorAll('.eye-tab')]
  assert.equal(tabs.some(el=>el.textContent?.includes('top-agent')),true)
  assert.equal(tabs.some(el=>/outer|inner|empty/.test(el.textContent??'')),false)
  const top=tabs.find(el=>el.textContent?.includes('top-agent'))!
  assert.equal(top.querySelector('.eye-tab-x')===null,true)
  assert.equal(tabs.find(el=>el.textContent?.includes('audience-agent'))?.querySelector('.eye-tab-x')!==null,true)
})
for(const top of [false,true]) test(`draft scope inherits from ${top?'org':'agent'} through projects`, async t=>{
  installFetch(new FakeServer())
  const map=index(top?[project('placement')]:[agent('boss',[project('placement')])])
  const tree={...settings,slug:'synthetic',dirs:[{path:'C:/org',mode:'rw'}],default_tools:{bash:true,mcp:[]}}
  let saved:DraftScope|undefined
  const view=await mountView(<DraftScopeModal draft={{parent:'placement',tier:'sol'}} map={map} tree={tree as TreePayload}
    scope={null} onSave={s=>{saved=s}} close={()=>{}} accounts={[]} />,el=>el)
  t.after(()=>view.unmount());await flush(4)
  const save=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='apply')
  assert.ok(save,'production scope Apply exists')
  await inAct(()=>save.click())
  assert.deepEqual(saved?.add_dirs,[{path:top?'C:/org':'C:/boss',mode:top?'rw':'ro'}])
  assert.equal(saved?.tools.bash,top)
})
