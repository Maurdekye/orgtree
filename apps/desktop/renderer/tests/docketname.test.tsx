// canonize-the-model-chip-and-clickable-agent-name, the last two surfaces:
// the docket's OWNER GROUP HEADING, and an AGENT NAMED IN ORDINARY PROSE.
//
// WHAT THESE TESTS ARE FOR, and it is not "a chip appears". Two claims can go
// wrong here in ways that read perfectly on screen:
//
//  1. THE GROUP HEAD MAY OVER-CLAIM. A heading names ONE agent but its group
//     can hold items owned by DIFFERENT GENERATIONS of that name. A chip drawn
//     from the live tree would then attribute today's model to work owned by a
//     generation that ran under something else. §N3 is that case, and it
//     carries its own positive control: the same fixture with the generations
//     agreeing MUST show the chip, or "no chip" would be free.
//
//  2. PROSE MAY INVENT AN IDENTITY. Only a name that still resolves in this
//     org's tree may link at all, and the chip it wears is the CURRENT model
//     of the desk it goes to — never a guess when that model is unknown.
//     (Astra ruling 2026-09-05: a chip beside every agent name; in prose it is
//     navigation, not authorship, and the tooltip says `current model`.) §N5
//     and §N7 hold both halves, each with a control that could have fired.
//
// Run: cd frontend && node tests/run.mjs docketname

import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DocketModal, agentItems, groupIdentity } from '../src/canvas/docket'
import type { NodeFacts } from '../src/canvas/docket'
import type { TreePayload, WorkItem } from '../src/types'

const mkItem = (o: Partial<WorkItem>): WorkItem => ({
  slug: 'unnamed-fixture-item', rev: 1, kind: 'code', title: 'Item',
  objective: '', status: 'in_progress', blocked_reason: null,
  archived: false, archived_at: null,
  owner: { node: 'checklist-evidence', generation: 2 }, owner_current: true,
  owner_state: 'live', participants: [],
  created_by: { node: 'checklist-evidence', generation: 2 },
  at: '2026-09-05T08:00:00.000Z', updated_at: '2026-09-05T09:00:00.000Z',
  done_so_far: [], working_on_next: [],
  docket_at: '2026-09-05T09:00:00.000Z',
  last_updater: { node: 'checklist-evidence', generation: 2 },
  manual_attention: null, dismissals: [], questions: [],
  effective_attention: false, attention_sources: [],
  acceptance: [], dependencies: [], evidence: [], delivery: null,
  accepted: null, superseded_by: null, history: [],
  ...o,
} as unknown as WorkItem)

/** the org this suite runs in: one coordinator, one report, both live and both
 *  wearing a model — so "no chip" and "no link" are always answers this
 *  fixture COULD have contradicted. */
const mkTree = (): TreePayload => ({
  slug: 'org1', name: 'Org 1', epoch: 1, rev: 1,
  roots: [{
    id: 'coordinator-astra', tier: 'opus', generation: 1, state: 'live',
    children: [{
      id: 'checklist-evidence', tier: 'fable', generation: 2, state: 'live',
      children: [],
    }, {
      // a live, reachable agent whose model this app does not know. It links
      // and it wears NO chip — the case that keeps §N7's chip from being
      // decoration applied to everything that matches.
      id: 'tierless-agent', generation: 1, state: 'live', children: [],
    }],
  }],
  work_items_summary: { attention: 0, active: 0 },
  user_inbox_count: 0, user_inbox_urgent_count: 0, asks: [], asks_open: 0,
} as unknown as TreePayload)

function mockServer(items: WorkItem[]) {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => {
      const ok = (payload: unknown) => Promise.resolve({
        ok: true, status: 200, headers: new Headers(),
        json: () => Promise.resolve(payload),
      })
      if (String(url).includes('/work-items')) {
        return ok({
          items,
          counts: { attention: 0, active: items.length, archived: 0, backlogged: 0 },
          now: '2026-09-05T10:00:00.000Z',
        })
      }
      return ok({})
    }) as unknown as typeof fetch
}

test('agent docket excludes canonical archived rows by default and includes them when requested', () => {
  const active = mkItem({ slug: 'active-item', archived: false })
  const archived = mkItem({ slug: 'archived-item', archived: true,
    archived_at: '2026-09-05T10:00:00.000Z' })
  const data = { items: [active], archived: [archived], backlogged: [] }
  assert.deepEqual(agentItems(data, 'checklist-evidence')?.map((x) => x.slug),
    ['active-item'])
  assert.deepEqual(agentItems(data, 'checklist-evidence', true)?.map((x) => x.slug),
    ['active-item', 'archived-item'])
})

function uiTest(name: string, body: (mount: (v: React.ReactElement)
  => Promise<HTMLElement>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    let open: { unmount: () => Promise<void> } | null = null
    t.after(async () => {
      try { await open?.unmount() } finally {
        realClock()
        window.localStorage.removeItem('orgtree.docket.group')
      }
    })
    window.localStorage.removeItem('orgtree.docket.group')
    await body(async (v) => {
      const view = await mountView(v, (host) => host)
      open = view
      return view.el
    })
  })
}

/** the grouping is a stored display preference, so this is how a test asks for
 *  by-agent grouping without going through the control strip */
const groupByAgent = () =>
  window.localStorage.setItem('orgtree.docket.group', 'agent')

/** ⚠ NEVER `assert.equal(node, null)`. Node's assertion diff walks a jsdom
 *  element when it fails, and a real DOM blows the heap: the run dies with
 *  `Array buffer allocation failed` after half a minute and the MESSAGE NEVER
 *  PRINTS. Found by mutating this suite — four mutants went red for a reason
 *  no reader could see. Compare a boolean instead. */
const absent = (node: unknown, msg: string) =>
  assert.equal(node === null || node === undefined, true, msg)

const heads = (el: HTMLElement) =>
  [...el.querySelectorAll('.docket-group-head')] as HTMLElement[]
const agentHead = (h: HTMLElement) =>
  h.querySelector('.docket-group-agent') as HTMLElement | null
const rows = (el: HTMLElement) => [...el.querySelectorAll('.mailrow.docket-row')]
const pane = (el: HTMLElement) => el.querySelector('.mailer-read')
const desc = (el: HTMLElement) =>
  pane(el)?.querySelector('.docket-desc-body') as HTMLElement | null

async function openFirst(el: HTMLElement) {
  await inAct(() => (rows(el)[0] as HTMLElement).click())
  await flush()
}

// ------------------------------------------------- the owner group heading

uiTest('§N1 an agent group head IS the agent — chip and jump; a word is not',
  async (mount) => {
    groupByAgent()
    mockServer([
      mkItem({ slug: 'first-item' }),
      mkItem({ slug: 'ownerless-item', owner: null } as Partial<WorkItem>),
    ])
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree()} onFocusAgent={() => {}} />)
    await flush()

    const [agent, unassigned] = heads(el)
    assert.ok(agent && unassigned, 'expected an agent group and the unassigned one')
    // the named agent: chip, and the name is the control that navigates
    const id = agentHead(agent!)
    assert.ok(id, 'the agent group head did not render an identity')
    assert.equal(id!.querySelector('.tier')?.textContent, 'F',
      "the group head wears the agent's model chip")
    const btn = id!.querySelector('button.cc-name') as HTMLElement | null
    assert.ok(btn, 'the group head name is not clickable')
    assert.equal(btn!.textContent, 'checklist-evidence')

    // THE CONTROL: `Unassigned` is a word, not a name. No chip, no button —
    // and if the renderer ever treats a heading string as an id, this fails.
    absent(agentHead(unassigned!),
      'the owner-less group was drawn as if it were an agent')
    absent(unassigned!.querySelector('.tier'),
      'the owner-less group wears a model chip')
    absent(unassigned!.querySelector('button'),
      'the owner-less group heading is a control')
    assert.match(unassigned!.textContent ?? '', /Unassigned/)
  })

uiTest('§N2 the group head name goes to that agent, and closes the panel',
  async (mount) => {
    groupByAgent()
    mockServer([mkItem({ slug: 'first-item' })])
    const went: string[] = []
    let closed = 0
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => { closed += 1 }}
        tree={mkTree()} onFocusAgent={(id) => went.push(id)} />)
    await flush()
    const btn = heads(el)[0]!.querySelector('button.cc-name') as HTMLElement
    await inAct(() => btn.click())
    await flush()
    assert.deepEqual(went, ['checklist-evidence'])
    assert.equal(closed, 1, 'the panel stayed open over the desk it focused')
  })

uiTest('§N3 a group with an active earlier generation uses the current model',
  async (mount) => {
    groupByAgent()
    // Both items are owned by `checklist-evidence`; one names the generation
    // the tree still has and one an earlier generation. They resolve to the
    // same live successor and therefore to one current model.
    mockServer([
      mkItem({ slug: 'newer-item' }),
      mkItem({ slug: 'older-item',
        owner: { node: 'checklist-evidence', generation: 1 } } as Partial<WorkItem>),
    ])
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree()} onFocusAgent={() => {}} />)
    await flush()
    const id = agentHead(heads(el)[0]!)
    assert.ok(id, 'the agent group head vanished')
    assert.equal(id!.querySelector('.tier')?.textContent, 'F',
      'the heading uses the current successor model for both generations')
    // the name still navigates — the agent is reachable
    assert.ok(id!.querySelector('button.cc-name'))
  })

uiTest('§N3b …and with the generations agreeing, the same fixture DOES chip',
  async (mount) => {
    groupByAgent()
    mockServer([
      mkItem({ slug: 'newer-item' }),
      mkItem({ slug: 'older-item' }),
    ])
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree()} onFocusAgent={() => {}} />)
    await flush()
    assert.equal(
      agentHead(heads(el)[0]!)?.querySelector('.tier')?.textContent, 'F',
      'the two-item group shows no chip even when both owners agree — §N3 '
      + 'proves nothing')
  })

test('§N4 groupIdentity: one answer, or none — the unit', () => {
  const facts = new Map<string, NodeFacts>([
    ['a', { tier: 'opus', generation: 2, live: true }],
  ])
  const own = (generation: number) =>
    mkItem({ owner: { node: 'a', generation } } as Partial<WorkItem>)
  assert.equal(groupIdentity([own(2), own(2)], facts).tier, 'opus')
  assert.equal(groupIdentity([own(2), own(1)], facts).tier, 'opus')
  // a retired agent is still the same generation: the model that did the work
  // IS recorded, so the chip stays and the reason says what happened
  const retired = new Map<string, NodeFacts>([
    ['a', { tier: 'opus', generation: 2, live: false }],
  ])
  assert.equal(groupIdentity([own(2)], retired).tier, 'opus')
  assert.match(groupIdentity([own(2)], retired).why ?? '', /retired/)
  // an agent the tree no longer has: no model, and a reason
  assert.equal(groupIdentity([own(2)], new Map()).tier, undefined)
  assert.equal(groupIdentity([], facts).why, null)
})

// ------------------------------------------------------ agents named in prose

uiTest('§N5 bare agent names in prose are words, even when this org has them',
  async (mount) => {
    mockServer([mkItem({
      slug: 'first-item',
      objective: 'coordinator-astra asked, and ghost-agent never existed.',
    })])
    const went: string[] = []
    let closed = 0
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => { closed += 1 }}
        tree={mkTree()} onFocusAgent={(id) => went.push(id)} />)
    await flush()
    await openFirst(el)

    const links = [...(desc(el)?.querySelectorAll('.docket-ref-agent, .ref-chip.ref-agent') ?? [])]
    assert.equal(links.length, 0,
      'a bare agent name became an unintended prose link')
    assert.equal(desc(el)?.textContent,
      'coordinator-astra asked, and ghost-agent never existed.')
    assert.deepEqual(went, [])
    assert.equal(closed, 0)
  })

uiTest('§N6 an ITEM named exactly like an agent is still the item',
  async (mount) => {
    // the collision is the point: one word, two possible meanings. In the
    // docket the item wins, and the reader is not silently sent to a desk.
    mockServer([
      mkItem({ slug: 'checklist-evidence', title: 'A work item, not an agent' }),
      mkItem({ slug: 'holder', objective: 'see checklist-evidence for that.' }),
    ])
    const went: string[] = []
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree()} onFocusAgent={(id) => went.push(id)} />)
    await flush()
    // open `holder`, whose description carries the colliding name
    const holder = rows(el).find((r) => /holder/.test(r.textContent ?? ''))
    await inAct(() => (holder as HTMLElement).click())
    await flush()
    const link = desc(el)?.querySelector('.docket-ref') as HTMLElement | null
    assert.ok(link, 'the colliding name did not link at all')
    assert.equal(link!.classList.contains('docket-ref-agent'), false,
      'the agent won a name the docket also has as an item')
    await inAct(() => link!.click())
    await flush()
    assert.deepEqual(went, [], 'clicking the mention left the docket')
    assert.match(pane(el)?.textContent ?? '', /A work item, not an agent/,
      'the mention did not select the item it names')
  })

uiTest('§N7 agent names in prose stay plain while actor attribution remains',
  async (mount) => {
    mockServer([mkItem({
      slug: 'first-item',
      objective: 'coordinator-astra asked, and tierless-agent agreed.',
      done_so_far: ['handed to coordinator-astra'],
    })])
    const el = await mount(
      <DocketModal slug="org1" toast={() => {}} close={() => {}}
        tree={mkTree()} onFocusAgent={() => {}} />)
    await flush()
    await openFirst(el)

    // Agent names in ordinary prose are no longer destinations, even when the
    // catalogue contains both names. The actor line is still a deliberate
    // structural control and remains attributed normally.
    assert.equal(desc(el)?.querySelectorAll(
      '.docket-ref-agent, .ref-chip.ref-agent').length, 0,
      'a bare prose agent name became an unintended link')
    assert.match(desc(el)?.textContent ?? '',
      /coordinator-astra asked, and tierless-agent agreed\./)

    // The ACTOR line is untouched by this prose rule: its chip is still the
    // recorded-generation claim, which is a different claim entirely.
    assert.equal(
      pane(el)?.querySelector('.docket-actor .tier')?.textContent, 'F',
      'the actor line stopped attributing the model it recorded')

    // A progress entry follows the same bare-name rule, not only the description.
    const list = pane(el)?.querySelector('.docket-list-items')
    assert.equal(list?.querySelectorAll(
      '.docket-ref-agent, .ref-chip.ref-agent').length, 0,
      'a bare progress-entry agent name became an unintended link')
  })
