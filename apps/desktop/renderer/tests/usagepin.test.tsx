// usagepin.test.tsx — the Usage-limits modal's pin/popout eligibility is
// CONTEXT-SENSITIVE (user correction 2026-09-10 14:19): it is the same modal
// everywhere, but with an org open it pins and pops out like any org
// surface, saved independently per org; at home (no org) only pin/popout
// are disabled — the modal itself still opens. This reverses its former
// membership in the always-global exclusion list.
//
// Run:  cd frontend && node tests/run.mjs usagepin
import { flush, inAct, mountView as rawMountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { ReactNode } from 'react'
import { forgetModalOpenCache, forgetModalPins, isModalPinned, PinFrame } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import { UsageModal } from '../src/App'

const noop = () => {}

/** the org canvas boxes the pin clamp measures (same shape the modalpin
 *  suite builds); plus the provider that tells PinFrame which org is open */
async function mountUsage(org: string | null, tail: { unmount: () => Promise<void> }[]) {
  const canvases = ['alpha', 'beta'].map(o => {
    const el = document.createElement('div'); el.dataset.pinOrg = o
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      width: window.innerWidth, height: window.innerHeight,
      right: window.innerWidth, bottom: window.innerHeight, toJSON() {} }) as DOMRect
    document.body.appendChild(el); return el
  })
  const node: ReactNode = (
    <CurrentOrg.Provider value={org}>
      <PinFrame kind="usage" title="Usage limits" panel="settings usage-modal" close={noop}>
        <h3>Usage limits</h3>
      </PinFrame>
    </CurrentOrg.Provider>
  )
  const v = await rawMountView(node, (el) => el)
  let done = false
  const unmount = async () => {
    if (done) return
    done = true
    await v.unmount()
    canvases.forEach(el => el.remove())
  }
  tail.push({ unmount })
  await flush()
  // a pinned surface may live in an adopted .movable-surface outside the host
  const q = (sel: string) => v.el.querySelector(sel)
    ?? [...document.querySelectorAll('.movable-surface')]
      .map(el => el.querySelector(sel)).find(Boolean) ?? null
  return { el: v.el, q, unmount }
}

function rig(name: string, body: (k: {
  mount: (org: string | null) => Promise<{ el: HTMLElement
    q: (s: string) => Element | null; unmount: () => Promise<void> }> }) => Promise<void>): void {
  test(name, async (t: TestContext) => {
    useFakeClock()
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
    const tail: { unmount: () => Promise<void> }[] = []
    t.after(async () => {
      for (const m of tail.reverse()) { try { await m.unmount() } catch { /* gone */ } }
      localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
      realClock()
    })
    await body({ mount: (org) => mountUsage(org, tail) })
  })
}

const PIN = 'button[aria-label="pin this to the window"]'

rig('with an org open, usage pins like any org surface — and per THAT org', async ({ mount }) => {
  const { q } = await mount('alpha')
  const pinBtn = q(PIN)
  assert.ok(pinBtn, 'the pin control is offered while an org is open')
  await inAct(async () => { (pinBtn as HTMLElement).click(); await flush() })
  assert.equal(isModalPinned('usage', 'alpha'), true, 'pinned under the open org')
  assert.equal(isModalPinned('usage', 'beta'), false, 'not under another org')
  assert.equal(isModalPinned('usage', null), false, 'and not under the old global scope')
  assert.equal(q('.modalpin-name')?.textContent, 'Usage limits')
  assert.notEqual(q('.modalpin-name')?.textContent, 'usage limits')
})

rig('at home the same modal opens but offers neither pin nor popout', async ({ mount }) => {
  const { el, q } = await mount(null)
  assert.match(el.textContent ?? '', /Usage limits/, 'the modal itself renders')
  assert.doesNotMatch(el.textContent ?? '', /usage limits/, 'the label must not have a lowercase u')
  assert.equal(q(PIN), null, 'no pin control without an org')
  assert.equal(q('button[title="Open in new window"]'), null, 'no popout either')
})

rig('each org keeps its own saved pin — a pin in alpha does not follow into beta', async ({ mount }) => {
  const a = await mount('alpha')
  await inAct(async () => { (a.q(PIN) as HTMLElement).click(); await flush() })
  assert.equal(isModalPinned('usage', 'alpha'), true)
  await a.unmount()   // the org switch unmounts the previous org's modal
  const b = await mount('beta')
  assert.equal(b.q('.modalpin-win'), null, 'beta renders it centred, unpinned')
  assert.ok(b.q(PIN), 'beta may pin it independently')
  assert.equal(isModalPinned('usage', 'beta'), false)
})

test('UsageModal renders user-facing label "Usage limits" in both pinned title and unpinned heading', async (t: TestContext) => {
  useFakeClock()
  localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
  t.after(() => {
    localStorage.clear(); forgetModalPins(); forgetModalOpenCache()
    realClock()
  })
  const canvases = ['alpha'].map(o => {
    const el = document.createElement('div'); el.dataset.pinOrg = o
    el.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0,
      width: window.innerWidth, height: window.innerHeight,
      right: window.innerWidth, bottom: window.innerHeight, toJSON() {} }) as DOMRect
    document.body.appendChild(el); return el
  })
  const g = globalThis as unknown as Record<string, unknown>
  g.fetch = (url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname
    const body = path.endsWith('/providers') ? { providers: [] }
      : path.endsWith('/accounts') ? { accounts: [] }
      : {}
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) })
  }
  try {
    const v = await rawMountView(
      <CurrentOrg.Provider value="alpha">
        <UsageModal close={noop} toast={noop} />
      </CurrentOrg.Provider>,
      (el) => el
    )
    await inAct(async () => { await flush(5) })

    // 1. Unpinned heading:
    const h3 = v.el.querySelector('h3')
    assert.ok(h3, 'h3 heading exists')
    assert.match(h3.textContent ?? '', /Usage limits/)
    assert.doesNotMatch(h3.textContent ?? '', /usage limits/)

    // 2. Pin the modal:
    const pinBtn = v.el.querySelector(PIN)
    assert.ok(pinBtn, 'pin button exists')
    await inAct(async () => { (pinBtn as HTMLElement).click(); await flush() })

    const q = (sel: string) => v.el.querySelector(sel)
      ?? [...document.querySelectorAll('.movable-surface')]
        .map(el => el.querySelector(sel)).find(Boolean) ?? null

    const pinnedHeading = q('.modalpin-name')
    assert.ok(pinnedHeading, 'pinned heading element exists')
    assert.equal(pinnedHeading.textContent, 'Usage limits')
    assert.notEqual(pinnedHeading.textContent, 'usage limits')

    await v.unmount()
    canvases.forEach(el => el.remove())
  } finally {
    delete g.fetch
  }
})

