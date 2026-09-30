// activitytitle.test.tsx — the footer's live/active agents chip and its tooltip.
//
// User 2026-09-30 (image-35): the chip read "27 live · 6 active O22 S4 A1"
// and its tooltip "active agents by organization — Orgtree: 4" — "this
// annotation lies". The letters are MODEL TIERS of this organization's live
// agents (Opus, Sonnet, Astra), and the tooltip was a different count polled
// separately. Pinned here: the tooltip says what the chip says, with the
// chip's own numbers — live broken down by tier, summing to the live figure,
// and the active figure — and other organizations are named as such.
import { mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ActiveAgentSummary, activeOrgTitle } from '../src/App'
import type { TreeNode, TreePayload } from '../src/types'

const agent = (id: string, tier: string, o: Partial<TreeNode> = {}): TreeNode => ({
  id, tier, state: 'live', busy: false, children: [], ...o,
} as unknown as TreeNode)

// 3 Opus (2 of them mid-turn), 1 Sonnet, 1 retired Opus that must not count
const tree = (): TreePayload => ({
  slug: 'orgtree', name: 'Orgtree', tiers: {},
  roots: [agent('a', 'opus', {
    busy: true,
    children: [agent('b', 'opus', { busy: true }), agent('c', 'sonnet'),
      agent('d', 'opus'), agent('old', 'opus', { state: 'archived' })],
  })],
} as unknown as TreePayload)

test('the tooltip breaks the chip down with the chip\'s own numbers', () => {
  assert.equal(activeOrgTitle(tree()),
    'Orgtree: 4 live agents — 1 Sonnet · 3 Opus\n2 active now (a turn running)')
})

test('the current organization is never listed again from the separately polled org list', () => {
  // the org list's `working` for THIS organization is polled on its own
  // clock and can disagree with the tree for a moment (the "4 vs 6" of the
  // report) — so it is not shown; other organizations are, labelled as such
  const title = activeOrgTitle(tree(), [
    { slug: 'orgtree', name: 'Orgtree', working: 7 },
    { slug: 'beta', name: 'Beta', working: 1 },
    { slug: 'idle', name: 'Idle', working: 0 },
    { slug: 'pub', name: 'Public row' },
  ])
  assert.equal(title, 'Orgtree: 4 live agents — 1 Sonnet · 3 Opus\n'
    + '2 active now (a turn running)\n'
    + 'active now in other organizations — Beta: 1')
  assert.doesNotMatch(title, /Orgtree: 7/)
})

test('the chip and its tooltip agree: tier counts sum to live, active matches', async (t) => {
  useFakeClock()
  const view = await mountView(
    <ActiveAgentSummary tree={tree()} orgs={[{ slug: 'beta', name: 'Beta', working: 2 }]} />,
    (el) => el,
  )
  t.after(async () => { await view.unmount(); realClock() })
  const chip = view.el.querySelector('.agents') as HTMLElement | null
  assert.ok(chip)
  const text = chip!.textContent ?? ''
  const live = Number(/(\d+) live/.exec(text)?.[1])
  const active = Number(/(\d+) active/.exec(text)?.[1])
  const letters = [...chip!.querySelectorAll('b')].map((b) => b.textContent ?? '')
  assert.deepEqual(letters, ['S1', 'O3'])
  assert.equal(letters.reduce((s, l) => s + Number(l.slice(1)), 0), live,
    'the tier chips break down the live figure')
  const title = chip!.getAttribute('title') ?? ''
  assert.match(title, new RegExp(`^Orgtree: ${live} live agents — 1 Sonnet · 3 Opus\\n`))
  assert.match(title, new RegExp(`\\n${active} active now`))
  assert.match(title, /other organizations — Beta: 2$/)
  assert.equal(chip!.getAttribute('role'), 'img')
  assert.equal(chip!.getAttribute('tabindex'), '0')
  assert.equal(chip!.getAttribute('aria-label'), title, 'keyboard focus gets the same text')
  assert.ok(!chip!.querySelector('[title]'), 'no inner title hides the chip\'s own tooltip')
})

test('nothing live and nothing active elsewhere: the tooltip still says so plainly', () => {
  assert.equal(activeOrgTitle({ slug: 'x', name: 'Empty', roots: [], tiers: {} } as unknown as TreePayload,
    [{ slug: 'y', name: 'Idle', working: 0 }]),
  'Empty: 0 live agents\n0 active now (a turn running)')
})
