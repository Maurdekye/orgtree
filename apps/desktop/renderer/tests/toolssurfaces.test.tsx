// The tool declaration on the three surfaces where a SEAT IS CHOSEN.
//
// ⚠ A HELPER TEST CANNOT SEE A CALLSITE DISAPPEAR. `toolsnote.test.tsx`
// proves the formatter says the right words and that the OpenRouter panel
// renders them. It says nothing about whether the hire sheet, the config
// model-switch or the rehire select still ask for them — delete any one of
// those calls and that file stays green. Each surface here is mounted from
// its own real component, so removing its call fails ITS control alone.
//
// ⚠ EVERY STRING IS A CATALOG DECLARATION, NOT AN OBSERVATION. Nothing here
// runs a turn, a tool call or a refusal against any model.

import { flush, FakeServer, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { HireSheet } from '../src/canvas/OrgCanvas'
import { NodeConfig } from '../src/canvas/modals'
import { LineagePanel } from '../src/canvas/desk'
import { hireOf, setOpenRouterTiers, USER } from '../src/canvas/shared'
import type { CanvasNode, HireState } from '../src/canvas/shared'
import type {
  OpRequest, OpResult, ProviderInfo, ProviderTier, TreePayload,
} from '../src/types'

const noop = () => {}
const SUPPORTED = /Tools: supported \(catalog\)/
const NOT_SUPPORTED = /Tools: not supported \(catalog\)/
const UNKNOWN = /Tools: unknown \(catalog\)/
// unit C (2026-09-05): the two declarations that joined `tools` on these
// same three surfaces. Each surface asserts a MIXED row, so a callsite
// printing one field's answer three times cannot pass.
const IMG_SUPPORTED = /Image input: supported \(catalog\)/
const IMG_NOT = /Image input: not supported \(catalog\)/
const IMG_UNKNOWN = /Image input: unknown \(catalog\)/
const RSN_SUPPORTED = /Reasoning parameter: supported \(catalog\)/
const RSN_NOT = /Reasoning parameter: not supported \(catalog\)/
const RSN_UNKNOWN = /Reasoning parameter: unknown \(catalog\)/

const tier = (over: Partial<ProviderTier>): ProviderTier => ({
  tier: 'or-x', provider: 'openrouter', seat: 1, model: 'v/x',
  letter: 'X', color: '#888888', name: 'X', label: 'x', vendor: 'v',
  prompt: 1, completion: 2, context: 100000, ...over,
} as ProviderTier)

const OR_TIERS: ProviderTier[] = [
  tier({ tier: 'or-v-full', model: 'v/full', name: 'Full', label: 'full',
    letter: 'F', tools: true, image: true, reasoning: true }),
  tier({ tier: 'or-v-textonly', model: 'v/textonly', name: 'Textonly',
    label: 'textonly', letter: 'T', tools: false, image: false,
    reasoning: false }),
  tier({ tier: 'or-v-silent', model: 'v/silent', name: 'Silent',
    label: 'silent', letter: 'S', tools: null, image: null, reasoning: null }),
  // ⚠ THE MIXED TIER. Every other row answers identically on all three
  // axes, so a surface rendering the TOOLS note three times would pass
  // without this one. Tools yes, image no, reasoning unknown.
  tier({ tier: 'or-v-mixed', model: 'v/mixed', name: 'Mixed', label: 'mixed',
    letter: 'M', tools: true, image: false, reasoning: null }),
]

const provider = (id: string, tiers: ProviderTier[] = []): ProviderInfo => ({
  id, label: id, cli: 'x', tiers, hire_enabled: true, user_enabled: true,
  reason: null, status: { installed: true, connected: true },
} as unknown as ProviderInfo)

const hire = (id: string): HireState | null => hireOf(provider(id))

const treeFixture = (): TreePayload => ({
  slug: 'org', dirs: [],
  tiers: { haiku: 1, sonnet: 2, opus: 5, fable: 10, luna: 0.2, terra: 2,
    sol: 5, flash: 1, pro: 2, 'or-v-full': 1, 'or-v-textonly': 1,
    'or-v-silent': 1, 'or-v-mixed': 1, 'or-v-deselected': 1 },
  max_top_grant: 100, default_effort: '', effort_default: 'high',
  cascade_hire: true,
} as unknown as TreePayload)

const nodeFixture = (tierId = 'haiku'): CanvasNode => ({
  id: 'agent', title: 'agent', state: 'live', tier: tierId, model_id: tierId,
  parent: USER, children: [], seat: 1, grant: 10, free: 10,
  scope: { permission_mode: 'acceptEdits', add_dirs: [],
    tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
    org_visibility: 'team' },
  charter: '', team_charter: '', turns: [], audiences_held: [],
} as unknown as CanvasNode)

test('the HIRE SHEET states the declaration on every offered OpenRouter tier',
  async () => {
    installFetch(new FakeServer())
    setOpenRouterTiers(OR_TIERS)
    const view = await mountView(
      <HireSheet anchor={nodeFixture()} seats={{}} defaultGrant={0}
        claudeHire={hire('claude')} openrouterHire={hire('openrouter')}
        onHire={noop} onClose={noop} />,
      (el) => el)
    await inAct(async () => { await flush() })
    const buttons = Array.from(view.el.ownerDocument.querySelectorAll('.hs-tier'))
    // ⚠ POSITIVE CONTROL FOR EVERY ABSENCE BELOW: the rows exist at all, so
    // a missing string means a missing note rather than a missing row.
    assert.ok(buttons.length, 'the sheet rendered tier buttons')
    const rowOf = (t: string) => buttons
      .find((b) => (b.className || '').split(/\s+/).includes('t-' + t))
    for (const t of ['or-v-full', 'or-v-textonly', 'or-v-silent',
      'or-v-mixed', 'haiku']) {
      assert.ok(rowOf(t), `${t} is offered by the sheet`)
    }
    assert.match(rowOf('or-v-full')!.title, SUPPORTED)
    assert.match(rowOf('or-v-textonly')!.title, NOT_SUPPORTED)
    // 4.x: only KNOWN declarations are shown, in the tooltip (user 2026-10-07)
    assert.equal(rowOf('or-v-silent')!.title.includes('Tools:'), false)
    // unit C: image input and the reasoning parameter on the same rows
    assert.match(rowOf('or-v-full')!.title, IMG_SUPPORTED)
    assert.match(rowOf('or-v-full')!.title, RSN_SUPPORTED)
    assert.match(rowOf('or-v-textonly')!.title, IMG_NOT)
    assert.match(rowOf('or-v-textonly')!.title, RSN_NOT)
    // ⚠ THE MIXED ROW: three different answers at once
    const mixed = rowOf('or-v-mixed')!.title
    assert.match(mixed, SUPPORTED)
    assert.match(mixed, IMG_NOT)
    assert.doesNotMatch(mixed, /Reasoning parameter:/)
    // static lanes are untouched: the catalog is an OpenRouter fact
    for (const re of [/Tools:/, /Image input:/, /Reasoning parameter:/]) {
      assert.doesNotMatch(rowOf('haiku')!.title, re)
    }
    // ⚠ STILL HIREABLE. Disclosure, never admission control.
    assert.equal((rowOf('or-v-textonly') as HTMLButtonElement).disabled, false,
      'a declared tool-less tier is still hireable from the sheet')
    await view.unmount()
    setOpenRouterTiers([])
  })

test('the CONFIG model-switch states it for every offered OpenRouter tier',
  async () => {
  installFetch(new FakeServer())
  setOpenRouterTiers(OR_TIERS)
  // the node runs on a favorite that has since been DESELECTED - see the
  // recorded finding at the end of this test
  const nd = nodeFixture('or-v-deselected')
  const view = await mountView(
    <NodeConfig node={nd} map={new Map([[nd.id, nd]])} tree={treeFixture()}
      slug="org" toast={noop}
      op={(_x: OpRequest) => Promise.resolve({} as OpResult)}
      openrouterProvider={provider('openrouter', OR_TIERS)}
      close={noop} />,
    (el) => el)
  await inAct(async () => { await flush() })
  const opts = Array.from(
    view.el.querySelectorAll<HTMLOptionElement>('.model-switch option'))
  assert.ok(opts.length, 'the switch rendered options')
  const byValue = (v: string) => {
    const o = opts.find((x) => x.value === v)
    assert.ok(o, `${v} is offered by the switch`)
    return (o!.title || '') + ' | ' + (o!.textContent ?? '')
  }
  assert.match(byValue('or-v-full'), SUPPORTED)
  assert.match(byValue('or-v-textonly'), NOT_SUPPORTED)
  // 4.x: only KNOWN declarations show, in the option tooltip (user 2026-10-07)
  assert.doesNotMatch(byValue('or-v-silent'), /Tools:/)
  // unit C, and the mixed option is what makes these non-vacuous
  assert.match(byValue('or-v-full'), IMG_SUPPORTED)
  assert.match(byValue('or-v-full'), RSN_SUPPORTED)
  assert.match(byValue('or-v-textonly'), IMG_NOT)
  assert.match(byValue('or-v-mixed'), SUPPORTED)
  assert.match(byValue('or-v-mixed'), IMG_NOT)
  assert.doesNotMatch(byValue('or-v-mixed'), /Reasoning parameter:/)
  for (const re of [/Tools:/, /Image input:/, /Reasoning parameter:/]) {
    assert.doesNotMatch(byValue('haiku'), re)
  }
  // A DESELECTED favorite that a node still runs on remains visible in the
  // model-switch dropdown as its truthful current model (w76fba70b), without
  // bypassing admission for new hires or switches for other agents.
  const deselectedOpt = opts.find((o) => o.value === 'or-v-deselected')
  assert.ok(deselectedOpt, 'a deselected favorite is kept visible as the current model')
  assert.equal(deselectedOpt.disabled, false, 'the node’s own deselected model is selectable (truthful no-op)')
  assert.match(byValue('or-v-deselected'), /deselected/)
  // ⚠ PRESENCE IS THE WEAKER CLAIM. An option can exist in the list while the
  // select still displays something else — which is the very failure this fix
  // is about: the control read as though the node were running on a model it is
  // not. So assert what the control actually SHOWS (Astra review 2026-09-05).
  const sel = view.el.querySelector<HTMLSelectElement>('.model-switch')
  assert.ok(sel, 'the model switch is rendered')
  assert.equal(sel.value, 'or-v-deselected',
    'the switch DISPLAYS the node’s own deselected tier as the current value')
  assert.equal(deselectedOpt.selected, true,
    'and it is that option which is selected, not merely present')
  await view.unmount()

  // CONTROL: for a node on another tier, the deselected favorite is NOT offered
  const otherNode = nodeFixture('haiku')
  const viewOther = await mountView(
    <NodeConfig node={otherNode} map={new Map([[otherNode.id, otherNode]])} tree={treeFixture()}
      slug="org" toast={noop}
      op={(_x: OpRequest) => Promise.resolve({} as OpResult)}
      openrouterProvider={provider('openrouter', OR_TIERS)}
      close={noop} />,
    (el) => el)
  await inAct(async () => { await flush() })
  const otherOpts = Array.from(
    viewOther.el.querySelectorAll<HTMLOptionElement>('.model-switch option'))
  assert.equal(otherOpts.find((o) => o.value === 'or-v-deselected'), undefined,
    'a deselected favorite is not offered as a switch target for other agents')
  await viewOther.unmount()
  setOpenRouterTiers([])
})

