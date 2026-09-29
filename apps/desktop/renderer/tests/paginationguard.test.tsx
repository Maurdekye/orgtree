import { FakeServer, flush, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { useEffect } from 'react'
import { addPending, loadOlder, refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'
import type { ChatPayload } from '../src/types'

for (const viewport of [false, true]) {
  for (const kind of ['same cursor', 'repeated page', 'empty page'] as const) {
    test(`${viewport ? 'viewport' : 'history'} fill stops on ${kind} instead of repeating requests`, async t => {
      resetConvos()
      const server = new FakeServer()
      server.assistantMsg('current transcript')
      const tail = server.chat(8)
      let calls = 0
      let fill = true
      server.chat = (): ChatPayload => {
        calls++
        if (calls === 1) return { ...tail, has_older: true, before: 'cursor-a' }
        return { ...tail, has_older: true,
          before: kind === 'same cursor' ? 'cursor-a' : `cursor-${calls}`,
          messages: kind === 'empty page' ? [] : kind === 'same cursor' && !viewport
            ? [{ role: 'assistant', text: 'older', seq: -1, event_id: 'older' }] : tail.messages }
      }
      installFetch(server)
      let latest: Convo
      function FillingDesk() {
        const c = useConvo('pagination', 'agent')
        latest = c
        useEffect(() => { if (!c.loaded) void refreshConvo('pagination', 'agent') }, [c.loaded])
        // The real desk refills a short viewport after every installed page.
        // Cap this fixture at six requests so the old code fails without hanging.
        useEffect(() => {
          if (fill && c.loaded && !c.loadingOlder && c.chat?.has_older && calls < 6)
            loadOlder('pagination', 'agent', 8, viewport)
        }, [c.chat, c.loaded, c.loadingOlder])
        return null
      }
      const warnings: unknown[][] = []
      const warn = console.warn
      console.warn = (...args) => warnings.push(args)
      const v = await mountView(<FillingDesk />, () => null)
      t.after(async () => { await v.unmount(); resetConvos(); console.warn = warn })
      await inAct(() => flush(20))
      assert.equal(calls, 2, 'one initial read and one rejected page; no automatic retry loop')
      assert.equal(latest!.loadingOlder, false)
      assert.equal(latest!.chat!.has_older, false)
      assert.equal(latest!.chat!.messages[0]!.text, 'current transcript', 'last usable rows stay visible')
      assert.equal(warnings.length, 1, 'one diagnostic, with no transcript body')
      assert.equal(loadOlder('pagination', 'agent', 8, viewport), false)
      // A later valid poll may make history available again.
      fill = false
      server.chat = () => ({ ...tail, has_older: true, before: 'recovered' })
      await inAct(() => refreshConvo('pagination', 'agent', { force: true }))
      assert.equal(latest!.chat!.has_older, true)
    })
  }
}

for (const proof of [false, true]) for (const cycle of [true, false]) {
  test(`${proof ? 'mail proof' : 'burst'} reconciliation stops at ${cycle ? 'a cursor cycle' : 'the page limit'}`, async t => {
    resetConvos()
    const server = new FakeServer()
    const base = server.chat(8)
    let phase = 'tail'
    let pages = 0
    server.chat = () => {
      let seq = 100
      let before = 'history'
      if (phase === 'history') { seq = 90; before = 'history-older' }
      if (phase === 'burst') {
        seq = 500 - pages
        before = cycle ? `burst-${pages % 2}` : `burst-${pages}`
        pages++
      }
      return { ...base, has_older: true, before,
        messages: [{ role: 'assistant', text: `row ${seq}`, seq, event_id: `row-${seq}` }] }
    }
    installFetch(server)
    let latest: Convo
    function Desk() {
      const c = useConvo('burst', 'agent')
      latest = c
      useEffect(() => { if (!c.loaded) void refreshConvo('burst', 'agent') }, [c.loaded])
      return null
    }
    const warnings: unknown[][] = []
    const warn = console.warn
    console.warn = (...args) => warnings.push(args)
    const v = await mountView(<Desk />, () => null)
    t.after(async () => { await v.unmount(); resetConvos(); console.warn = warn })
    await inAct(() => flush(5))
    if (proof) {
      await inAct(() => { addPending('burst', 'agent', 'undelivered question') })
    } else {
      phase = 'history'
      await inAct(async () => { loadOlder('burst', 'agent', 8); await flush(5) })
      assert.equal(latest!.paged, true)
    }
    const held = latest!.chat!.messages.map(row => row.seq)
    phase = 'burst'
    await inAct(() => refreshConvo('burst', 'agent', { force: true }))
    assert.equal(pages, cycle ? 3 : 65, 'one tail read plus bounded interval pages')
    if (proof) {
      assert.equal(latest!.pending.length, 1, 'unseen mail remains visible as pending')
      assert.ok(latest!.chat!.messages.length <= 65, 'proof work installs only its bounded range')
    } else {
      assert.deepEqual(latest!.chat!.messages.map(row => row.seq), held,
        'keep the last usable range instead of silently joining disjoint history')
    }
    assert.equal(warnings.length, 1)
  })
}
