// deskjumpscroll.test.tsx — the desks' jump rows (Orgtree 4.4.0; docket
// `desk-jump-cards-subordinate-and-superior-scroll-b`, user 2026-10-20
// 09:41Z-09:43Z and 09:50Z).
//
// WHAT THIS FILE HOLDS THE CODE TO:
//   §1 every jump row (an agent desk's superiors and reports, a project desk's
//      superiors and members) scrolls once its chips would take more than 8
//      rows, and nothing else about it is restyled: no background, border or
//      padding (user 09:43Z). The rule is CSS; the capture
//      (projectnode-visual.cjs, PROJECTNODE_VISUAL_ONLY=jumpscroll) measures
//      the rows, the cap and a real wheel over a desk on the canvas;
//   §2 the superior row folds only where the report row folds (more than 16
//      cards with "Collapse many jump cards on desks" on, user 09:50Z), and
//      then the agent superior stays in front and only the project levels
//      fold, behind "N projects" (user 09:42Z), on agent and project desks.
//
// Run:  cd apps/desktop/renderer && node tests/run.mjs deskjumpscroll

import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import { DeskChat } from '../src/canvas/desk'
import { ProjectDesk } from '../src/canvas/projectdesk'
import { DESK_JUMP_FOLD_LIMIT, JUMP_FOLD_KEY, setJumpFoldOn } from '../src/canvas/shared'
import type { CanvasNode } from '../src/canvas/shared'
import { resetConvos } from '../src/convo'
import type { OpResult, TreePayload } from '../src/types'

declare const __SRC_DIR__: string

/* ─── §1 the scroll cap ─────────────────────────────────────────────────── */

const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
/** a selector list split at its top-level commas, not those inside `:is(...)` */
function selectorList(prelude: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < prelude.length; i++) {
    if (prelude[i] === '(') depth++
    else if (prelude[i] === ')') depth--
    else if (prelude[i] === ',' && depth === 0) { out.push(prelude.slice(start, i)); start = i + 1 }
  }
  out.push(prelude.slice(start))
  return out.map((s) => s.trim().replace(/\s+/g, ' '))
}
/** the top-level rules: [selectors, body] (at-rules are not walked) */
function rules(src: string): [string[], string][] {
  const out: [string[], string][] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open < 0) break
    const prelude = src.slice(i, open).split(';').pop()!.trim()
    let depth = 1, j = open + 1
    for (; j < src.length && depth > 0; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') depth-- }
    if (!prelude.startsWith('@')) out.push([selectorList(prelude), src.slice(open + 1, j - 1)])
    i = j
  }
  return out
}
const all = rules(css)
const decl = (body: string, prop: string) => body.match(new RegExp(`(?:^|;)\\s*${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`))?.[1]?.trim()
const only = (selector: string) => {
  const found = all.filter(([s]) => s.includes(selector))
  assert.equal(found.length, 1, `exactly one rule for ${selector}`)
  return found[0]![1]
}

test('§1 every jump row scrolls past 8 rows of chips, and is not otherwise restyled (user 2026-10-20 09:41Z, 09:43Z)', () => {
  const row = only('.desk-nav')
  // as before: a wrapping row of chips, 5px apart, 3px above and below
  for (const [prop, value] of [['display', 'flex'], ['flex-wrap', 'wrap'], ['gap', '5px'], ['padding', '3px 0'], ['min-height', '0']]) {
    assert.equal(decl(row, prop), value, `.desk-nav ${prop} as before`)
  }
  // a chip's row: its 11.5px text at the body's 1.5 line height, 2px padding and a 1px border above and below
  assert.equal(decl(row, '--desk-nav-row'), 'calc(11.5px * 1.5 + 6px)')
  // eight rows, the seven gaps between them and the row's own padding (border-box)
  assert.equal(decl(row, 'max-height'), 'calc(8 * var(--desk-nav-row) + 7 * 5px + 6px)')
  assert.equal(decl(row, 'overflow-y'), 'auto', 'beyond 8 rows it scrolls')
  assert.equal(decl(row, 'overscroll-behavior'), 'contain', 'and its scroll never carries on into the desk behind it')
  for (const prop of ['background', 'background-color', 'border', 'border-top', 'border-radius', 'box-shadow', 'outline']) {
    assert.equal(decl(row, prop), undefined, `no ${prop}: just scrollable (user 09:43Z)`)
  }
  assert.deepEqual(all.filter(([s]) => s.some((x) => /\.desk-nav(?![-\w])[^\s>+~]*$/.test(x))).map(([s]) => s.join(', ')), ['.desk-nav'],
    'no other rule styles a jump row')
  // the row unit is the chip's: if the chip changes, the cap must change with it
  const chip = only('.desk-nav-chip')
  assert.equal(decl(chip, 'font-size'), '11.5px')
  assert.equal(decl(chip, 'padding'), '2px 8px')
  assert.match(decl(chip, 'border') ?? '', /^1px /)
  assert.match(decl(all.find(([s, b]) => s.includes('body') && decl(b, 'font'))![1], 'font') ?? '', /^13px\/1\.5 /,
    'the body line height the chip inherits')
  assert.equal(decl(all.find(([s]) => s.includes('*'))![1], 'box-sizing'), 'border-box', 'the cap counts the row\'s padding')
})

/* ─── §2 the superior row ───────────────────────────────────────────────── */

const agent = (id: string, parent: string | null, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, parent, kind: 'agent', state: 'live', tier: 'haiku', model_id: 'haiku', children: [], seat: 1, grant: 0, free: 0,
  scope: { tools: {}, add_dirs: [] }, configured_scope: { tools: {}, add_dirs: [] }, ...extra,
} as unknown as CanvasNode)
const project = (id: string, parent: string | null) => agent(id, parent, { kind: 'project', tier: 'project', model_id: '' } as Partial<CanvasNode>)
/** boss > p1 > ... > pN > the leaf (an agent `me`, or the project `p{N+1}`) */
function chain(levels: number, leaf: 'agent' | 'project' = 'agent') {
  const boss = agent('boss', null)
  const projects = Array.from({ length: levels }, (_, i) => project(`p${i + 1}`, i === 0 ? 'boss' : `p${i}`))
  const above = levels ? `p${levels}` : 'boss'
  const me = leaf === 'agent' ? agent('me', above) : project(`p${levels + 1}`, above)
  const map = new Map<string, CanvasNode>([[boss.id, boss], ...projects.map((p) => [p.id, p] as [string, CanvasNode]), [me.id, me]])
  return { me, map, ids: ['boss', ...projects.map((p) => p.id)] }
}
async function agentDesk(t: TestContext, levels: number) {
  localStorage.removeItem(JUMP_FOLD_KEY)
  installFetch(new FakeServer())
  const { me, map, ids } = chain(levels)
  const jumped: string[] = []
  const view = await mountView(<DeskChat node={me} map={map} op={() => Promise.resolve({} as OpResult)}
    slug="org" toast={() => {}} bare onJump={(id) => { jumped.push(id) }} />, (el) => el)
  t.after(async () => { await view.unmount(); resetConvos(); localStorage.removeItem(JUMP_FOLD_KEY) })
  await inAct(async () => { await flush(4) })
  // `me` has no reports and no dogs: its only jump row is the superior row
  const rows = view.el.querySelectorAll<HTMLElement>('.desk-nav')
  assert.equal(rows.length, 1, 'the superior row alone')
  return { row: rows[0]!, ids, jumped }
}
const chips = (row: Element) => [...row.querySelectorAll('.desk-nav-chip')].map((c) => c.getAttribute('data-copy-agent-name'))
const foldOf = (row: Element) => row.querySelector<HTMLButtonElement>('[data-audience-fold]')

test('§2 up to 16 superior cards: every one shows, with no fold, as before (user 09:50Z)', async (t) => {
  const { row, ids } = await agentDesk(t, DESK_JUMP_FOLD_LIMIT - 1)
  assert.equal(foldOf(row), null)
  assert.deepEqual(chips(row), ids, 'the agent superior, then each project level, outermost first')
})

test('§2 more than 16: the agent superior stays in front and only the project levels fold, behind "N projects" (user 09:42Z, 09:50Z)', async (t) => {
  const { row, ids, jumped } = await agentDesk(t, DESK_JUMP_FOLD_LIMIT)
  const fold = foldOf(row)
  assert.ok(fold, 'seventeen cards fold, as the report row does')
  assert.deepEqual(chips(row), ['boss'], 'the single superior always stays visible')
  assert.equal(fold!.textContent, '16 projects')
  assert.equal(fold!.getAttribute('aria-expanded'), 'false', 'folded at the start, as the report row')
  assert.equal(row.firstElementChild?.querySelector('[data-copy-agent-name]')?.getAttribute('data-copy-agent-name'), 'boss',
    'the superior comes before the fold')
  await inAct(() => { fold!.click() })
  assert.equal(fold!.textContent, 'hide 16 projects')
  assert.deepEqual(chips(row), ids, 'opened: the superior, then the levels in order')
  await inAct(() => { row.querySelector<HTMLButtonElement>('[data-copy-agent-name="p3"]')!.click() })
  await inAct(() => { row.querySelector<HTMLButtonElement>('[data-copy-agent-name="boss"]')!.click() })
  assert.deepEqual(jumped, ['p3', 'boss'], 'the cards still jump')
  await inAct(() => { fold!.click() })
  assert.deepEqual(chips(row), ['boss'], 'folded again, the superior still there')
})

test('§2 with "Collapse many jump cards on desks" off, nothing folds; turning it on folds the levels again', async (t) => {
  const { row, ids } = await agentDesk(t, DESK_JUMP_FOLD_LIMIT)
  await inAct(() => { setJumpFoldOn(false) })
  assert.equal(foldOf(row), null)
  assert.deepEqual(chips(row), ids)
  await inAct(() => { setJumpFoldOn(true) })
  assert.deepEqual(chips(row), ['boss'])
  assert.equal(foldOf(row)?.getAttribute('aria-expanded'), 'false')
})

test("§2 a project desk's superior row folds the same way", async (t) => {
  localStorage.removeItem(JUMP_FOLD_KEY)
  installFetch(new FakeServer())
  const { me, map, ids } = chain(DESK_JUMP_FOLD_LIMIT, 'project')
  const tree = { slug: 'org', roots: [...map.values()] } as unknown as TreePayload
  const view = await mountView(<ProjectDesk node={me} slug="org" tree={tree} map={map} op={async () => ({})} toast={() => {}}
    refs={{ world: { org: 'org' } } as never} bare onJump={() => {}} />, (el) => el)
  t.after(async () => { await view.unmount(); localStorage.removeItem(JUMP_FOLD_KEY) })
  await inAct(async () => { await flush(4) })
  const row = view.el.querySelector<HTMLElement>('.cc-head + .desk-nav')!
  assert.ok(row, 'the superior row under the header')
  assert.deepEqual(chips(row), ['boss'])
  assert.equal(foldOf(row)?.textContent, '16 projects')
  await inAct(() => { foldOf(row)!.click() })
  assert.deepEqual(chips(row), ids)
})
