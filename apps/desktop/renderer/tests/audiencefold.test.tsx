// audiencefold.test.tsx — the two mail surfaces use one live-holder fold.
//
// Browser layout decides the threshold (seven holder chips fit one standard
// mail row; eight begins another). These component checks pin the semantic
// boundary and the security-facing org-inbox summary; the companion browser
// probe owns pixels, real click behaviour, and screenshots.
//
// Run: cd frontend && node tests/run.mjs audiencefold

import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AudienceFold, AUDIENCE_FOLD_LIMIT, OrgInboxModal } from '../src/canvas/mail'
import type { TreePayload } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `holder${i + 1}`)
const noop = () => {}

function uiTest(name: string, body: (mount: (v: React.ReactElement)
  => Promise<{ el: HTMLElement }>) => Promise<void>) {
  test(name, async (t: TestContext) => {
    useFakeClock()
    let open: { el: HTMLElement; unmount: () => Promise<void> } | null = null
    t.after(async () => { try { await open?.unmount() } finally { realClock() } })
    await body(async (v) => {
      const view = await mountView(v, (host) => host)
      open = view
      return { el: view.el }
    })
  })
}

const chips = (el: HTMLElement) => [...el.querySelectorAll('.test-holder')]
const fold = (el: HTMLElement) => el.querySelector('[data-audience-fold]') as HTMLButtonElement | null

function simple(count: number) {
  return <AudienceFold ids={ids(count)} label="audience holders"
    render={(id) => <span className="test-holder" key={id}>{id}</span>} />
}

uiTest('§1 seven live audience holders stay fully visible — no needless control',
  async (mount) => {
    const { el } = await mount(simple(AUDIENCE_FOLD_LIMIT - 1))
    await flush()
    assert.equal(chips(el).length, AUDIENCE_FOLD_LIMIT - 1,
      'the last one-row list remains plain chips')
    assert.equal(fold(el), null, 'there is no disclosure control below the limit')
  })

uiTest('§2 at eight live audience holders the default is a counted closed fold, then one click reveals all',
  async (mount) => {
    const { el } = await mount(simple(AUDIENCE_FOLD_LIMIT))
    await flush()
    const button = fold(el)
    assert.ok(button, 'the threshold creates an audience-fold control')
    assert.equal(button.getAttribute('aria-expanded'), 'false', 'the threshold arrives collapsed')
    assert.match(button.textContent ?? '', /8 audience holders/, 'the closed summary names its count')
    assert.equal(chips(el).length, 0, 'the hidden holders are not silently still in the row')
    await inAct(() => button.click())
    assert.equal(button.getAttribute('aria-expanded'), 'true', 'the same control reports its opened state')
    assert.equal(chips(el).length, AUDIENCE_FOLD_LIMIT, 'one click reveals every holder')
  })

function inbox(count: number): TreePayload['org_inbox'] {
  return { entries: [], unread: 0, holders: ids(count), visible: true }
}

function liveMap(count: number) {
  return new Map(ids(count).map((id) => [id, { id, state: 'live' } as CanvasNode]))
}

uiTest('§3 org inbox uses the same threshold but makes an unexpected multi-holder count a warning',
  async (mount) => {
    const { el } = await mount(<OrgInboxModal inbox={inbox(AUDIENCE_FOLD_LIMIT)}
      map={liveMap(AUDIENCE_FOLD_LIMIT)} slug="mine" toast={noop} close={noop} />)
    await flush()
    const button = fold(el)
    assert.ok(button, 'the org inbox uses the shared fold at the same boundary')
    assert.equal(button.getAttribute('aria-expanded'), 'false', 'the org list also starts closed')
    assert.ok(button.classList.contains('alert'),
      'more than the expected single external-mail reader remains visibly anomalous')
    assert.match(button.textContent ?? '', /⚠.*8 org inbox audience holders/,
      'the security summary says exactly what is unusual before expanding')
    assert.equal(el.querySelectorAll('.chip-x').length, 0,
      'collapsed recipients are actually folded, so the warning cannot pass by counting exposed chips')
    await inAct(() => button.click())
    assert.equal(el.querySelectorAll('.chip-x').length, AUDIENCE_FOLD_LIMIT,
      'expanding reveals each recipient and its revoke affordance')
  })

// Anti-vacuity witness: the same observation reports the opposite state for a
// value replacement at the boundary. If a future selector/control disappears,
// this cannot pass merely because it happened to find no holders.
uiTest('§4 CONTROL: replacing 8 with 7 makes the folded-state witness go false',
  async (mount) => {
    const { el } = await mount(simple(AUDIENCE_FOLD_LIMIT - 1))
    await flush()
    assert.equal(fold(el), null,
      'a value-replaced below-limit fixture is visibly not folded — §2 sees a real distinction')
    assert.equal(chips(el).length, AUDIENCE_FOLD_LIMIT - 1,
      'and the control case proves the chip counter can be non-zero')
  })
