// `starting...` describes one interval: a busy turn before its first event.
// It must not be re-appended between later durable events merely because the
// server has swept the matching live row. The test mounts the real DeskChat.
// Its first assertion is the anti-vacuity control: the status element must
// actually exist before activity, then the same reader must find none after.
//
// Run: cd frontend && node tests/run.mjs startingstatus

import {
  FakeServer, flush, inAct, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { markBusy, refreshConvo, resetConvos } from '../src/convo'
import { DeskChat } from '../src/canvas/desk'
import type { CanvasNode } from '../src/canvas/shared'
import type { ChatPayload, OpResult } from '../src/types'

const noop = () => {}
const op = () => Promise.resolve({} as OpResult)

function node(id: string): CanvasNode {
  return {
    id, state: 'live', tier: 'haiku', children: [], seat: 1, grant: 0, free: 0,
    scope: { tools: {}, add_dirs: [] }, model_id: 'haiku',
  }
}

function startingRows(el: HTMLElement): Element[] {
  return [...el.querySelectorAll('.msg')].filter(
    (row) => row.textContent?.trim().endsWith('starting…'))
}

test('starting appears once before activity, not between durable events',
  async (t: TestContext) => {
    useFakeClock()
    const slug = 'org'
    const nid = 'starting-worker'
    const server = new FakeServer()
    server.busy = true
    let activity = false
    const realChat = server.chat.bind(server)
    server.chat = (last): ChatPayload => ({
      ...realChat(last), turn_activity: activity,
    } as ChatPayload)
    installFetch(server)

    const nd = node(nid)
    const view = await mountView(
      <DeskChat node={nd} map={new Map([[nid, nd]])} op={op} slug={slug}
        toast={noop} pub={false} bare />,
      (host) => host)
    t.after(async () => {
      try { await view.unmount() } catch { /* gone */ }
      resetConvos()
      realClock()
    })

    await inAct(() => refreshConvo(slug, nid, { force: true }))
    await flush()
    assert.equal(startingRows(view.el).length, 1,
      'the pre-activity control did not render a starting status element')

    // The live row has already been replaced by its durable transcript twin:
    // busy=true, live=[], and a visible event. This is the user's reported
    // between-events frame; old code rendered `starting...` at the bottom.
    server.assistantMsg('durable event canary')
    activity = true
    await inAct(() => refreshConvo(slug, nid, { force: true }))
    await flush()

    assert.match(view.el.textContent ?? '', /durable event canary/,
      'the durable event control is absent, so no between-events state exists')
    assert.equal(startingRows(view.el).length, 0,
      '`starting...` reappeared after activity in the same busy turn')

    // The next optimistic send is a genuinely new pre-activity interval. It
    // must not inherit the completed turn's latch and suppress the indicator.
    server.busy = false
    await inAct(() => refreshConvo(slug, nid, { force: true }))
    await inAct(() => markBusy(slug, nid))
    assert.equal(startingRows(view.el).length, 1,
      'a new turn inherited the previous turn activity and never showed starting')
  })
