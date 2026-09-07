// quietpeers.test.tsx — the compose picker must not present an unreachable
// recipient as an ordinary one.
//
// THE SYMPTOM THE USER ACTUALLY FEELS. A hub roster row outlives its org:
// the hub keeps a registration until ORG_RETENTION_DAYS (45) of silence, and
// until 2026-09-04 nothing in orgtree ever called the hub's /api/unregister,
// so a deleted org stayed in the picker for weeks. Measured on the live hub
// that day: 135 rows, 132 with no local org of that base slug, 3 online. The
// picker offered all 135 as chips with only a dull dot to tell them apart.
//
// WHAT IS DELIBERATELY NOT DONE HERE, and it is the whole design:
//
//   * nothing is deleted and nothing is hidden permanently. The fold opens.
//     A row whose org lives on ANOTHER install pointed at the same hub is not
//     dead, it is remote — "I cannot see it" is a fact about the observer.
//   * a peer with NO last_seen is never folded. Absence of a reading is not
//     evidence of silence, and guessing the other way removes a good
//     recipient on the strength of a missing field.
//   * `online` always wins over any age arithmetic: a peer answering right
//     now is reachable whatever its timestamp says.
//   * free-typed addressing (FR-07) is untouched — addressing must never be
//     gated on a live roster.
//
// Hermetic: pure component mounts, no fetch, fake clock.
//
// Run:  cd frontend && node tests/run.mjs quietpeers

import { inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { OrgInboxModal, peerAgeLabel, peerQuietDays, QUIET_PEER_DAYS }
  from '../src/canvas/mail'
import type { NetHub, NetPeer, TreePayload } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

const noop = () => {}
const NOW = Date.parse('2026-09-04T12:00:00Z')
const ago = (days: number) =>
  new Date(NOW - days * 86400000).toISOString().replace('.000', '')

const q = (el: HTMLElement, sel: string) => [...el.querySelectorAll(sel)]
const chipNames = (el: HTMLElement) =>
  q(el, '.cmp-chip').map((n) => (n.textContent ?? '').trim())

function peer(slug: string, over: Partial<NetPeer> = {}): NetPeer {
  return { slug, org_name: slug.split('.')[0], online: false,
    last_seen: ago(1), kind: 'org', transports: ['net'], ...over }
}

function hub(roster: NetPeer[]): NetHub {
  return { id: 'local', address: 'http://127.0.0.1:7370', enabled: true,
    name: 'nova-desk', connected: true, queued: 0, roster }
}

function box(): TreePayload['org_inbox'] {
  return { entries: [], unread: 0, holders: ['ceo'], visible: true }
}

function modal(roster: NetPeer[]) {
  return (
    <OrgInboxModal inbox={box()} net={{ slug: 'mine.op.abc123',
      hubs: [hub(roster)] }}
      map={new Map<string, CanvasNode>()} slug="mine" toast={noop}
      close={noop} jumpTo={null} />
  )
}

/** open the modal and click through to the compose picker */
async function compose(roster: NetPeer[]) {
  const v = await mountView(modal(roster), (host) => host)
  const btn = q(v.el, 'button').find(
    (b) => (b.textContent ?? '').includes('compose mail'))
  assert.ok(btn, 'no compose button on the org inbox modal')
  await inAct(() => { (btn as HTMLButtonElement).click() })
  return v
}

function uiTest(name: string, body: () => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    Date.now = () => NOW
    t.after(() => { realClock() })
    await body()
  })
}

// ------------------------------------------------------------------- pure
test('peerQuietDays measures days, and refuses to guess', () => {
  assert.equal(peerQuietDays(ago(0), NOW), 0)
  assert.equal(peerQuietDays(ago(9), NOW), 9)
  assert.equal(peerQuietDays(null, NOW), null,
    'a peer with no reading must not be called quiet')
  assert.equal(peerQuietDays(undefined, NOW), null)
  assert.equal(peerQuietDays('not a date', NOW), null,
    'an unparseable timestamp must read as no measurement, not as day zero')
})

test('peerAgeLabel stays short enough for a chip', () => {
  assert.equal(peerAgeLabel(ago(0), NOW), 'now')
  assert.equal(peerAgeLabel(new Date(NOW - 5 * 3600000).toISOString(), NOW),
    '5h')
  assert.equal(peerAgeLabel(ago(12), NOW), '12d')
  assert.equal(peerAgeLabel(null, NOW), '')
})

// -------------------------------------------------------------------- DOM
uiTest('a long-silent peer is folded away, not offered as an ordinary chip',
  async () => {
    const v = await compose([
      peer('alive.op.aaa', { online: true, last_seen: ago(0) }),
      peer('recent.op.bbb', { last_seen: ago(2) }),
      peer('ancient.op.ccc', { last_seen: ago(30) }),
    ])
    const names = chipNames(v.el)
    assert.ok(names.some((n) => n.includes('alive')), names.join('|'))
    assert.ok(names.some((n) => n.includes('recent')), names.join('|'))
    assert.ok(!names.some((n) => n.includes('ancient')),
      `a peer silent for 30 days was offered as an ordinary recipient: ${
        names.join('|')}`)
    await v.unmount()
  })

uiTest('...and the fold OPENS — nothing is hidden permanently', async () => {
  const v = await compose([
    peer('alive.op.aaa', { online: true, last_seen: ago(0) }),
    peer('ancient.op.ccc', { last_seen: ago(30) }),
  ])
  const toggle = q(v.el, '.cmp-quiet-toggle button')[0] as HTMLButtonElement
  assert.ok(toggle, 'no disclosure offered for the folded peers')
  assert.ok((toggle.textContent ?? '').includes('1'),
    `the toggle does not say how many are folded: ${toggle.textContent}`)
  await inAct(() => { toggle.click() })
  assert.ok(chipNames(v.el).some((n) => n.includes('ancient')),
    'opening the fold did not reveal the quiet peer')
  await v.unmount()
})

uiTest('an ONLINE peer is never folded, whatever its timestamp says',
  async () => {
    const v = await compose([
      peer('answering.op.ddd', { online: true, last_seen: ago(99) }),
    ])
    assert.ok(chipNames(v.el).some((n) => n.includes('answering')),
      'a peer answering right now was folded on the strength of a stale '
      + 'timestamp')
    assert.equal(q(v.el, '.cmp-quiet-toggle').length, 0,
      'a fold was offered when nothing is folded')
    await v.unmount()
  })

uiTest('a peer with NO last_seen is never folded', async () => {
  const v = await compose([peer('unknown.op.eee', { last_seen: null })])
  assert.ok(chipNames(v.el).some((n) => n.includes('unknown')),
    'a peer with no reading was folded — absence of a measurement is not '
    + 'evidence of silence')
  await v.unmount()
})

uiTest('an offline chip states its age instead of only dimming a dot',
  async () => {
    const v = await compose([peer('idle.op.fff', { last_seen: ago(3) })])
    const chip = q(v.el, '.cmp-chip').find(
      (c) => (c.textContent ?? '').includes('idle'))
    assert.ok(chip, 'the idle peer is missing entirely')
    assert.ok((chip!.textContent ?? '').includes('3d'),
      `the chip does not say how old the peer is: ${chip!.textContent}`)
    assert.ok((chip!.getAttribute('title') ?? '').includes('last seen'),
      `the tooltip does not name the last contact: ${
        chip!.getAttribute('title')}`)
    await v.unmount()
  })

uiTest('the boundary is exactly QUIET_PEER_DAYS', async () => {
  const v = await compose([
    peer('under.op.ggg', { last_seen: ago(QUIET_PEER_DAYS - 1) }),
    peer('over.op.hhh', { last_seen: ago(QUIET_PEER_DAYS) }),
  ])
  const names = chipNames(v.el)
  assert.ok(names.some((n) => n.includes('under')), names.join('|'))
  assert.ok(!names.some((n) => n.includes('over')), names.join('|'))
  await v.unmount()
})

uiTest('free-typed addressing survives the fold (FR-07)', async () => {
  const v = await compose([peer('ancient.op.ccc', { last_seen: ago(30) })])
  const other = q(v.el, 'button').find(
    (b) => (b.textContent ?? '').trim().toLowerCase().includes('other'))
  assert.ok(other, 'the free-entry chip is gone — addressing must never be '
    + 'gated on a live roster')
  await v.unmount()
})
