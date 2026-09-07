// actlabel.test.tsx — the live-activity label on a busy agent's card.
//
// USER BUG 2026-08-26: "when an agent is actively working, their zoomed out
// status text sometimes overflows and flows off of their card, going to the
// side or below it." The tool name was a BARE TEXT NODE inside a flex row —
// an anonymous flex item, which cannot carry `text-overflow`, and whose
// automatic minimum size is its longest unbreakable word. Tool names are
// nothing but long unbreakable words, so the row wrapped to a second line and
// that line still ran past the border: measured at +50.95px on a card with
// 108px to give, far enough to land on the neighbouring card.
//
// ⚠ WHAT THIS FILE CAN AND CANNOT PROVE. The bug is text too wide for a box,
// and jsdom has no box model — every width it reports is 0, for a broken card
// exactly as for a correct one. So there is NO assertion here about anything
// fitting; a check like that would be a guess about glyph advance dressed up
// as a measurement, and it would pass just as green on the broken code. (That
// is not hypothetical: a seat on this repo shipped one today that assumed a
// 58px box which really rendered at 101.63px.)
//
// What this file pins is the part that IS computable — the structural contract
// the stylesheet needs in order to be able to contain anything at all:
//
//   1. the name is rendered in its own ELEMENT, `.actlabel-text` — a bare text
//      node is unstyleable, so this is the whole precondition for the fix
//   2. the full name survives truncation, in the hover title
//   3. the card sheds the redundant `server: ` prefix, so two orgtree tools do
//      not both truncate to `orgtree: orgtr…`
//   4. the label appears on a busy card and nowhere else
//
// The layout itself is measured in a REAL browser by tests/actlabel_probe.py,
// which renders this markup against the real stylesheet and fails if any box
// escapes the card. Both files are needed; neither substitutes for the other.
//
// Run:  cd frontend && node tests/run.mjs actlabel
//       cd frontend && python tests/actlabel_probe.py

import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Activity } from '../src/canvas/desk'
import { NodeSquare } from '../src/canvas/cards'
import type { CanvasNode } from '../src/canvas/shared'
import type { ActivityInfo, OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id, state: 'live', tier: 'opus', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'opus', ...extra,
  }
}

const label = (act: ActivityInfo) =>
  mountView(<Activity act={act} />, (el) => el)

const card = (nd: CanvasNode, lod: 'mini' | 'norm' = 'norm') =>
  mountView(
    <NodeSquare node={nd} pos={{ x: 0, y: 0 }} lod={lod} focused={false}
      dragging={false} isDrop={false} seats={{ used: 1, total: 4 }}
      map={new Map([[nd.id, nd]])} op={op} slug="org" toast={noop}
      pxc={1} zoom={1} compactAt={0.8} pub={false} maxTop={0}
      kioskRemaining={null} cascadeAlloc
      onSpawn={noop} onSpawnSide={noop} onSpawnTop={noop} onConfig={noop}
      onInbox={noop} onLineage={noop} onOpenDoc={noop} onRecenter={noop}
      onJump={noop} onMailLink={noop} onDragStart={noop} onDragMove={noop}
      onDragEnd={noop} onDragCancel={noop} />,
    (el) => el)

// ① The precondition. Everything else in the fix is CSS, and CSS cannot reach
//    a bare text node: `text-overflow` needs a box. If this regresses, the
//    stylesheet silently stops containing anything and the probe's fixture
//    guard is the only thing left standing between that and the user.
test('the tool name renders in its own element, not as a bare text node',
  async () => {
    const { el } = await label({ phase: 'tool', tool: 'mcp__orgtree__orgtree_send_notice' })
    const text = el.querySelector('.actlabel-text')
    assert.ok(text, '.actlabel-text is missing — the name is unstyleable again '
      + 'and nothing in styles.css can contain it')
    assert.equal(text!.textContent, 'orgtree_send_notice')
    // and it must be the ONLY text in the row: a stray sibling text node is
    // another anonymous flex item, i.e. the original bug wearing a new hat
    const strays = [...el.querySelector('.actlabel')!.childNodes]
      .filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim())
    assert.deepEqual(strays.map((n) => n.textContent), [],
      'a bare text node is back in .actlabel')
  })

// ② Truncation is a DISPLAY decision. If the ellipsised text were the only
//    copy of the name, the fix would have traded an overflow for a redaction.
test('the full name, server prefix included, survives in the hover title',
  async () => {
    const { el } = await label({ phase: 'tool', tool: 'mcp__resonite__get_sync_object_definition' })
    assert.equal(el.querySelector('.actlabel')!.getAttribute('title'),
      'resonite: get_sync_object_definition')
  })

// ③ The card has ~15 monospace characters. `shortTool` spends nine of them on
//    the server prefix, so BOTH of these used to truncate to `orgtree: orgtr…`
//    — a status line that cannot distinguish two states is not reporting one.
//    (Caught by looking at a screenshot, after every numeric check was green.)
test('two tools on the same server stay distinguishable on the card',
  async () => {
    const a = await label({ phase: 'tool', tool: 'mcp__orgtree__orgtree_send_notice' })
    const b = await label({ phase: 'tool', tool: 'mcp__orgtree__orgtree_request_credits' })
    const txt = (v: typeof a) => v.el.querySelector('.actlabel-text')!.textContent!
    assert.notEqual(txt(a), txt(b))
    // they must differ EARLY — within what actually fits — not in a tail the
    // ellipsis eats. 15 chars is the card's real capacity, measured in Edge by
    // actlabel_probe.py; here it is only used to compare two strings.
    assert.notEqual(txt(a).slice(0, 15), txt(b).slice(0, 15),
      'the names differ only past the truncation point, so the card shows the '
      + 'same string for both')
  })

// a tool with no MCP prefix is not an MCP tool and must not be rewritten
test('a plain tool name is shown exactly as it is', async () => {
  for (const t of ['Read', 'TaskCreate', 'Bash']) {
    const { el } = await label({ phase: 'tool', tool: t })
    assert.equal(el.querySelector('.actlabel-text')!.textContent, t)
    assert.equal(el.querySelector('.actlabel')!.getAttribute('title'), t)
  }
})

// the non-tool phases go through the same single element — they are short
// today, but "short" is not a property anyone maintains
test('thinking and writing use the same containable element', async () => {
  for (const [phase, want] of [['thinking', 'thinking'], ['writing', 'writing']] as const) {
    const { el } = await label({ phase })
    assert.equal(el.querySelector('.actlabel-text')!.textContent, want)
  }
})

// ④ Where the label is allowed to appear. The full text form renders ONLY on a
//    busy card above the mini LOD — that is the surface with 108px, and the
//    reason the containment lives on `.actlabel` rather than on the card.
test('the text label appears on a busy card, and only there', async () => {
  const act: ActivityInfo = { phase: 'tool', tool: 'mcp__mcplink__get_protoflux_subgraph' }

  const busy = await card(node('a1', { busy: true, activity: act }))
  assert.ok(busy.el.querySelector('.actlabel-text'), 'no label on a busy card')

  const idle = await card(node('a2', { activity: act }))
  assert.equal(idle.el.querySelector('.actlabel'), null,
    'an idle agent is not doing anything, so it claims nothing')

  // at mini LOD the card IS the name; the activity collapses to a dot, which
  // has no text to overflow
  const mini = await card(node('a3', { busy: true, activity: act }), 'mini')
  assert.equal(mini.el.querySelector('.actlabel'), null)
  assert.ok(mini.el.querySelector('.actgear'), 'the mini card lost its busy dot')
})

test('a Sol card carries the OpenAI theme and the S tier tag', async () => {
  const codex = await card(node('codex-sol', {
    tier: 'sol', model_id: 'gpt-5.6-sol', seat: 5,
  }))
  const sq = codex.el.querySelector('.sq')
  assert.ok(sq?.classList.contains('prov-openai'),
    'the provider theme class is missing from the Codex card')
  assert.ok(sq?.classList.contains('tier-sol'),
    'the independent Sol tier stripe class is missing from the Codex card')
  assert.equal(sq?.querySelector('.tier')?.textContent, 'S')
})
