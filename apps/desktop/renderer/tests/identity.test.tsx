// identity.test.tsx — canvas/identity.tsx, the one place an agent's model chip
// and name are drawn.
//
// ⚠ WHY THIS FILE HAD TO EXIST BEFORE THE MIGRATION, NOT AFTER IT. The rule
// that a model chip is only shown when it can be honestly attributed lived in
// `docket.tsx` and was held down by `docket.test.tsx §24`. Moving the render
// into a shared component without a check pointed AT that component would
// leave the abstention exercised only through one caller — and the moment a
// second caller started passing today's tier for a historical generation,
// §24 would still be green. codex-checklist flagged exactly this, and it is
// the "present, plausible and inert" failure: a guard that reads correctly,
// runs, passes and means nothing.
//
// So: §A-§C are the component's own controls, and §D re-states the docket's
// rule directly against the component. Each was watched fail — see the
// mutation table at the bottom.
//
// Run:  cd frontend && node tests/run.mjs identity

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentName, TierChip } from '../src/canvas/identity'

const mount = async (el: React.ReactElement) => {
  const v = await mountView(el, (host) => host)
  await flush()
  return v
}
const chip = (el: HTMLElement) => el.querySelector('.tier')
const name = (el: HTMLElement) => el.querySelector('.cc-name')

test('§A the chip renders the model it is given, and nothing else', async () => {
  const { el, unmount } = await mount(<TierChip tier="sonnet" />)
  const c = chip(el)
  assert.ok(c, 'positive control: a chip renders at all')
  assert.ok(c!.classList.contains('t-sonnet'), 'and carries the tier class')
  assert.equal(c!.textContent?.trim(), 'S')
  await unmount()
})

test('§B NO TIER MEANS NO CHIP — the abstention, at the component', async () => {
  for (const tier of [null, undefined, '']) {
    const { el, unmount } = await mount(<TierChip tier={tier} />)
    assert.equal(chip(el), null,
      `tier=${JSON.stringify(tier)} must render no chip: an unknown model is `
      + 'an answer, and inventing one is the failure this guards')
    await unmount()
  }
})

test('§C AgentName passes the abstention through — it does not fill it in', async () => {
  // the SAME id, twice, differing only in whether a tier was supplied. This is
  // the shape of the real bug: a shared component that "helpfully" looks up
  // today's model would draw a chip in both.
  const withTier = await mount(<AgentName id="worker" tier="opus" />)
  assert.ok(chip(withTier.el), 'positive control: a supplied tier IS drawn')
  assert.equal(name(withTier.el)?.textContent, 'worker')
  await withTier.unmount()

  const without = await mount(<AgentName id="worker" tier={null} />)
  assert.equal(chip(without.el), null,
    'AgentName must never source a model the caller did not give it')
  assert.equal(name(without.el)?.textContent, 'worker',
    'the name is still shown — the identity is not hidden, only the model')
  await without.unmount()
})

test('§D navigation: a name with somewhere to go is a control; otherwise text',
  async () => {
    const seen: string[] = []
    const go = await mount(<AgentName id="cto" tier="haiku"
      onFocus={(id) => seen.push(id)} />)
    const btn = go.el.querySelector('button.cc-name.cc-name-jump')
    assert.ok(btn, 'a name that navigates is a button')
    assert.equal(btn!.getAttribute('title'), "focus cto's desk")
    await inAct(() => { (btn as HTMLElement).click() })
    assert.deepEqual(seen, ['cto'], 'and clicking it navigates to that agent')
    await go.unmount()

    // ⚠ THE EXEMPTION IS KEYED ON DESTINATION, NOT ON IDENTITY. This is the
    // agent's OWN focused desk — the place the click would take you — so the
    // click would be a no-op and the name is plain text. A switchboard panel
    // or a pinned window shows the SAME agent's name and must still navigate,
    // which is why no call site may infer this from the id.
    const here = await mount(<AgentName id="cto" tier="haiku" atDestination
      onFocus={() => assert.fail('a name at its own destination must not navigate')} />)
    assert.equal(here.el.querySelector('button'), null,
      'at the destination the name is not a control')
    assert.equal(name(here.el)?.textContent, 'cto')
    assert.ok(chip(here.el), 'but the model chip stays — only the link goes')
    await here.unmount()

    // no handler at all: plain text, not a button that does nothing
    const dead = await mount(<AgentName id="cto" tier="haiku" />)
    assert.equal(dead.el.querySelector('button'), null,
      'with no handler the name must be text, not an inert control')
    await dead.unmount()
  })

test('§E the id is rendered verbatim, prefix included, never resolved',
  async () => {
    // a deleted or unknown agent still reads as exactly what was recorded —
    // no lookup, no correction, no invented identity.
    const { el, unmount } = await mount(
      <AgentName id="never-existed" tier={null} prefix="@" />)
    assert.equal(name(el)?.textContent, '@never-existed')
    assert.equal(chip(el), null)
    await unmount()
  })

test('§F class order matches the markup it replaces', async () => {
  // docket.test.tsx §27 compares the className string exactly, to catch a new
  // control appearing beside the item name. Reordering here would break that
  // check for a reason unrelated to what it watches.
  const { el, unmount } = await mount(
    <AgentName id="a" tier="opus" nameClass="docket-actor-name"
      onFocus={() => {}} />)
  assert.equal(el.querySelector('button')?.className,
    'cc-name cc-name-jump docket-actor-name')
  await unmount()
})

// ---------------------------------------------------------------------------
// MUTATIONS RUN, each watched go red (edit canvas/identity.tsx, run, revert).
// These are the ones actually executed, not a list of ones that would work:
//
//   1. TierChip abstention replaced by a default model
//      (`const tier = t || 'haiku'`)          -> §B, §C, §E red
//      ⚠ AND `docket.test.tsx §24` RED WITH IT. That is the result this file
//      exists to produce: §24 is the check that kept the provenance rule
//      honest while it lived in docket.tsx, and it still fails when the
//      SHARED component starts inventing a model. The abstention did not
//      become untested by moving.
//   2. `atDestination` dropped from the branch condition  -> §D red
//   3. `!onFocus` dropped from the branch condition
//      (a missing handler renders an inert button again)  -> §D red
//   4. class order changed to `cc-name <extra> cc-name-jump`
//                                                         -> §F red, and
//      `docket.test.tsx §27` red with it
//
// §A stayed green under every one of them, which is what makes it a control
// rather than another assertion.
