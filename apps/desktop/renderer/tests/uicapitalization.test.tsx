// uicapitalization.test.tsx — regression coverage for normalized UI capitalization
// across modals, headings, buttons, and tab strips.
//
// Run:  cd frontend && node tests/run.mjs uicapitalization

import './harness'
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { DiskBrowser } from '../src/DiskBrowser'
import { NewOrg, InboxPanel } from '../src/App'
import { DraftScopeModal, PilePicker } from '../src/canvas/modals'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

if (typeof window !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {}
}

const noop = () => {}

function stubFetch(handlers: Record<string, (url: string) => unknown>) {
  const prevFetch = globalThis.fetch
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string | URL | Request) => {
    const urlStr = String(url)
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (urlStr.includes(prefix)) {
        const body = handler(urlStr)
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = prevFetch
  }
}

test('DiskBrowser renders normalized Sentence Case heading, PinFrame title, and mode tabs', async () => {
  const restoreFetch = stubFetch({
    '/disk': () => ({
      used: 200,
      total: 1000,
      blocked: false,
      full: false,
      files: [],
      offset: 0,
      limit: 200,
    }),
  })

  try {
    const view = await mountView(
      <CurrentOrg.Provider value="test-org">
        <DiskBrowser slug="test-org" isPublic={false} toast={noop} close={noop} />
      </CurrentOrg.Provider>,
      (el) => el
    )
    await flush()

    const h3 = view.el.querySelector('h3')
    assert.ok(h3, 'h3 heading exists')
    assert.match(h3.textContent ?? '', /Org disk/)
    assert.doesNotMatch(h3.textContent ?? '', /org disk/)

    const tabs = view.el.querySelectorAll('.disk-tabs button')
    assert.equal(tabs.length, 2)
    assert.equal(tabs[0].textContent, 'Largest files')
    assert.notEqual(tabs[0].textContent, 'largest files')
    assert.equal(tabs[1].textContent, 'Browse')
    assert.notEqual(tabs[1].textContent, 'browse')

    await view.unmount()
  } finally {
    restoreFetch()
  }
})

test('NewOrg renders "+ New organization" button and AdvancedOrgModal tabs use Sentence Case', async () => {
  const view = await mountView(<NewOrg onCreate={noop} />, (el) => el)
  await flush()

  const btn = view.el.querySelector('button.primary')
  assert.ok(btn, 'button exists')
  assert.equal(btn.textContent, '+ New organization')
  assert.notEqual(btn.textContent, '+ new organization')

  // Click to open the form
  await inAct(() => (btn as HTMLButtonElement).click())
  await flush()

  // Click advanced… to open AdvancedOrgModal
  const advBtn = view.el.querySelector('button.disclosure')
  assert.ok(advBtn, 'disclosure button exists')
  await inAct(() => (advBtn as HTMLButtonElement).click())
  await flush()

  const tabBtns = [...view.el.querySelectorAll('.adv-tab')].map((b) => b.textContent)
  assert.ok(tabBtns.includes('General'), 'General tab exists')
  assert.ok(!tabBtns.includes('general'), 'lowercase general tab absent')
  assert.ok(tabBtns.includes('Mailserver'), 'Mailserver tab exists')
  assert.ok(!tabBtns.includes('mailserver'), 'lowercase mailserver tab absent')

  await view.unmount()
})

test('InboxPanel renders "Your inbox" heading and "Mark all read" button', async () => {
  const restoreFetch = stubFetch({
    '/inbox': () => ({
      pending: [{ id: 'm1', from: 'alpha', at: '2026-09-12T00:00:00Z', body: 'hello' }],
      delivered: [],
      sent: [],
    }),
    '/audiences': () => ({ audiences: [], requests: [] }),
    '/events': () => ({ events: [] }),
  })

  const fakeTree: TreePayload = {
    slug: 'test-org',
    name: 'Test Org',
    tiers: { opus: { name: 'Opus' } },
    roots: [],
    nodes: [],
    default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
    default_visibility: 'full',
  } as unknown as TreePayload

  try {
    const view = await mountView(
      <CurrentOrg.Provider value="test-org">
        <InboxPanel slug="test-org" tree={fakeTree} toast={noop} close={noop} jumpTo={null} />
      </CurrentOrg.Provider>,
      (el) => el
    )
    await flush()

    const h3 = view.el.querySelector('h3')
    assert.ok(h3, 'h3 heading exists')
    assert.match(h3.textContent ?? '', /Your inbox/)
    assert.doesNotMatch(h3.textContent ?? '', /your inbox/)

    // Mark all read button exists when there are pending items
    const markBtn = [...view.el.querySelectorAll('button')].find((b) => /mark all read/i.test(b.textContent ?? ''))
    assert.ok(markBtn, 'mark all read button exists')
    assert.equal(markBtn.textContent, 'Mark all read')
    assert.notEqual(markBtn.textContent, 'mark all read')

    await view.unmount()
  } finally {
    restoreFetch()
  }
})

test('DraftScopeModal renders "Permissions" heading with initial capital', async () => {
  const restoreFetch = stubFetch({
    '/api/mcp': () => ({ servers: [] }),
    '/api/accounts': () => ({ accounts: [] }),
  })

  const fakeTree: TreePayload = {
    slug: 'test-org',
    name: 'Test Org',
    tiers: {},
    roots: [],
    nodes: [],
    default_tools: { bash: true, web: true, edit: true, subagents: true, mcp: [] },
    default_visibility: 'full',
  } as unknown as TreePayload

  try {
    const view = await mountView(
      <CurrentOrg.Provider value="test-org">
        <DraftScopeModal
          draft={{ id: 'd1', tier: 'opus' } as unknown as any}
          map={new Map()}
          tree={fakeTree}
          onSave={noop}
          close={noop}
        />
      </CurrentOrg.Provider>,
      (el) => el
    )
    await flush()

    const h3 = document.body.querySelector('.settings h3')
    assert.ok(h3, 'h3 heading exists')
    assert.match(h3.textContent ?? '', /Permissions/)
    assert.doesNotMatch(h3.textContent ?? '', /permissions\s*·/)

    await view.unmount()
  } finally {
    restoreFetch()
  }
})

test('PilePicker renders "Team stack" and "Retired pile" headings in Sentence Case', async () => {
  // 1. Crowd (team stack)
  const crowdView = await mountView(
    <PilePicker
      pile={{ kind: 'c', list: ['a1', 'a2'] } as any}
      map={new Map()}
      onPick={noop}
      close={noop}
    />,
    (el) => el
  )
  await flush()
  const crowdH3 = document.body.querySelector('.pile-picker h3')
  assert.ok(crowdH3, 'crowd h3 exists')
  assert.match(crowdH3.textContent ?? '', /Team stack/)
  assert.doesNotMatch(crowdH3.textContent ?? '', /team stack/)
  await crowdView.unmount()

  // 2. Retired pile
  const retiredView = await mountView(
    <PilePicker
      pile={{ kind: 'r', list: ['a1', 'a2'] } as any}
      map={new Map()}
      onPick={noop}
      close={noop}
    />,
    (el) => el
  )
  await flush()
  const retiredH3 = document.body.querySelector('.pile-picker h3')
  assert.ok(retiredH3, 'retired h3 exists')
  assert.match(retiredH3.textContent ?? '', /Retired pile/)
  assert.doesNotMatch(retiredH3.textContent ?? '', /retired pile/)
  await retiredView.unmount()
})
