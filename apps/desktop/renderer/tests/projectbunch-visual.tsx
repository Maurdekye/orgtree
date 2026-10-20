import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { CurrentOrg } from '../src/popout'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { AccountsPanel } from '../src/canvas/accounts'
import { withDraftTree, withPendingMoves, treeParents, layout } from '../src/canvas/shared'
import { withPendingOrder } from '../src/canvas/pendingorder'
import { projectDraftSteps } from '../src/canvas/newproject'
import type { TreeNode, TreePayload } from '../src/types'
import { agent, chain, project, bunchTree } from './projectbunch-fixture'

/** The review org of user 2026-10-20 09:08Z: stacks of 3/5/8/12/16 projects
 *  with three agents under each bottom project; split moves stack12-agent-b
 *  under stack16-11, ending the 16 run there. */
function reviewStacks(split: boolean): TreeNode[] {
  const stacks = [3, 5, 8, 12, 16].map(n => chain(n, ['a', 'b', 'c'].map(x => agent(`stack${n}-agent-${x}`)), `stack${n}`))
  if (split) {
    let bottom = stacks[3]!, at = stacks[4]!
    while (bottom.children[0]?.kind === 'project') bottom = bottom.children[0]
    while (at.id !== 'stack16-11') at = at.children[0]!
    at.children.push(bottom.children.splice(1, 1)[0]!)
  }
  return [agent('coordinator', [
    project('test-project', [project('listener-smoke', [0, 1, 2].map(i => agent(`worker-${i}`)))]),
    ...stacks, project('build-slot', Array.from({ length: 25 }, (_, i) => agent(`bs-${i}`))), project('empty-project'),
  ])]
}
const scene = new URLSearchParams(location.search).get('scene') ?? 'three'
localStorage.clear()
localStorage.setItem('orgtree-canvas-gl-wires', 'off')
localStorage.setItem('orgtree-start-zoom', '0')
localStorage.setItem('orgtree-project-bunches', scene.endsWith('-off') ? '0' : '1')
if (scene === 'reorder' || scene === 'rearrange-on')
  localStorage.setItem('orgtree-project-bunch-rearrange', '1')
if (scene === 'rearrange-off') localStorage.setItem('orgtree-project-bunches', '1')
localStorage.setItem('orgtree-chart-layout', scene === 'circular' || scene.startsWith('ring-') ? 'circular' : 'row')
const labels: Record<string, string> = {
  two: 'Two projects', three: 'Three projects', five: 'Five projects', seven: 'Seven projects',
  eight: 'Eight projects', twelve: 'Twelve projects', twenty: 'Twenty projects',
  'two-off': 'Bunching off: two projects', 'three-off': 'Bunching off: three projects',
  siblings: 'Side-by-side projects stay separate', split: 'A split ends one bunch; each branch starts its own',
  'agent-break': 'An agent ends a bunch; the next project run forms another',
  circular: 'Circular chart: the same ordered project bunch',
  far: 'Far zoom: separate project cards and order line',
  'insert-project': 'Insert a project above another project',
  'insert-agent': 'Insert above the sole bottom agent',
  'insert-split': 'Insert above one of several agents: the split stays',
  reorder: 'Drag the first project to the end of the bunch',
  'rearrange-off': 'Rearranging off (default): ordinary subtree dragging',
  'rearrange-on': 'Rearranging on: insertion point changes project order',
  'ring-whole': 'Circular chart: review stacks 3/5/8/12/16 above build-slot agents',
  'ring-split': 'Circular chart: stack12-agent-b moved under stack16-11 splits the 16 run',
  'ring-busy': 'Circular chart: a whole bunch among 24 agents on one ring',
  settings: 'App settings > Display',
}
const trees: Record<string, TreeNode[]> = {
  two: [chain(2)], three: [chain(3)], five: [chain(5)], seven: [chain(7)],
  eight: [chain(8)], twelve: [chain(12)], twenty: [chain(20)],
  'two-off': [chain(2)], 'three-off': [chain(3)],
  siblings: [project('left', [agent('alpha')]), project('right', [agent('beta')])],
  split: [chain(2, [chain(2, [agent('alpha')], 'left'), chain(2, [agent('beta')], 'right')], 'upper')],
  'agent-break': [chain(2, [agent('lead', [chain(2, [agent('worker')], 'lower')])], 'upper')],
  circular: [chain(5)], far: [chain(5)], reorder: [chain(3)],
  'insert-project': [chain(2, [agent('worker')])],
  'insert-agent': [chain(2, [agent('worker')])],
  'insert-split': [chain(2, [agent('worker'), agent('sibling')])],
  'ring-whole': reviewStacks(false), 'ring-split': reviewStacks(true),
  'ring-busy': [agent('top', [agent('lead', [...Array.from({ length: 12 }, (_, i) => agent(`left-${i}`)),
    chain(5, [agent('member')], 'run'), ...Array.from({ length: 12 }, (_, i) => agent(`right-${i}`))])])],
}
let current = bunchTree(trees[scene] ?? [chain(3)])
let publish = (_tree: TreePayload) => {}
const receipt: { steps: Record<string, unknown>[][]; parents: [string, string | null][] } = { steps: [], parents: [...treeParents(current)] }
;(window as unknown as { bunchReceipt: typeof receipt }).bunchReceipt = receipt
function execute(steps: Record<string, unknown>[]) {
  receipt.steps.push(steps)
  for (const step of steps) {
    if (step.op === 'moves') current = withPendingMoves(current,
      new Map((step.moves as { node: string; new_parent: string | null }[]).map(m => [m.node, m.new_parent])))
    else if (step.op === 'reorder') current = withPendingOrder(current, {
      parent: treeParents(current).get(String(step.node)) ?? null, block: [String(step.node)],
      slot: { before: step.before as string | undefined, after: step.after as string | undefined }, settled: false,
    })
    else if (step.op === 'create_project') {
      const wrap = (nodes: TreeNode[]): TreeNode[] => nodes.map(n => n.id === step.above
        ? project(String(step.name), [n]) : { ...n, children: wrap(n.children) })
      current = { ...current, roots: wrap(current.roots) }
    }
  }
  receipt.parents = [...treeParents(current)]
  publish(current)
}
const answer = (data: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }))
window.fetch = ((url, init) => {
  const path = new URL(String(url), location.href).pathname
  if (path.endsWith('/gesture')) {
    execute(JSON.parse(String(init?.body)).steps)
    return answer({ results: [] })
  }
  if (path.endsWith('/api/providers')) return answer({ providers: [] })
  if (path.endsWith('/api/accounts')) return answer({ version: 2, primary: null, keys: [], assignments: {}, accounts: [] })
  if (path.endsWith('/api/app-settings/runtime')) return answer({ warming_enabled: true, verbose_logging: false })
  return answer({ detail: 'not in the fixture' }, 404)
}) as typeof fetch

if (scene === 'far') {
  const positions = [...layout(withDraftTree(current, null)).values()]
  const xs = positions.map(p => p.x), ys = positions.map(p => p.y), z = 0.38
  localStorage.setItem('orgtree-start-view', 'remember')
  localStorage.setItem('orgtree-view-' + current.slug, JSON.stringify({
    x: 500 - (Math.min(...xs) + Math.max(...xs) + 124) * z / 2,
    y: 310 - (Math.min(...ys) + Math.max(...ys) + 124) * z / 2, z,
  }))
}
if (scene.startsWith('ring-')) {
  // Fit the whole circular chart; canvasTargets lifts it clear of the eye's headroom.
  const positions = [...layout(withDraftTree(current, null), new Map(), 'circular', true).values()]
  const xs = positions.map(p => p.x), ys = positions.map(p => p.y), lift = Math.max(0, 140 - Math.min(...ys))
  const w = Math.max(...xs) - Math.min(...xs) + 124, h = Math.max(...ys) - Math.min(...ys) + 124
  const z = Math.min(940 / w, 600 / h)
  localStorage.setItem('orgtree-start-view', 'remember')
  localStorage.setItem('orgtree-view-' + current.slug, JSON.stringify({
    x: 500 - (Math.min(...xs) + Math.max(...xs) + 124) * z / 2,
    y: 326 - (Math.min(...ys) + Math.max(...ys) + 2 * lift + 124) * z / 2, z,
  }))
}
function Fixture() {
  const [tree, setTree] = useState(current)
  publish = setTree
  const insert = () => {
    const anchor = scene === 'insert-project' ? 'project-2' : 'worker'
    execute(projectDraftSteps({ parent: treeParents(tree).get(anchor) ?? null,
      tier: 'project', project: true, above: { anchor } }, 'inserted', 'New project in the column') as unknown as Record<string, unknown>[])
  }
  return <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
    <style>{'html, body, #root { height: 100%; margin: 0 } .viewport { flex: 1; min-height: 0 }'}</style>
    <header style={{ height: 48, flexShrink: 0, padding: '12px 22px', font: '15px system-ui', color: 'var(--text)' }}>
      {labels[scene]} {scene.startsWith('insert-') && <button id="insert" onClick={insert} style={{ marginLeft: 18 }}>Create project above</button>}
    </header>
    <CurrentOrg.Provider value={tree.slug}>
      {scene === 'settings' ? <AccountsPanel initialTab="display" toast={() => {}} close={() => {}} />
        : <OrgCanvas tree={tree} slug={tree.slug} mailEvt={null} toast={() => {}} op={async request => {
          execute([request as unknown as Record<string, unknown>]); return {} as never
        }} />}
    </CurrentOrg.Provider>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
