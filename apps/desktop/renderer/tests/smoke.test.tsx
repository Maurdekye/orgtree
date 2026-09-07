// smoke — proves the rig itself works: jsdom + React + the mocked clock + the
// fetch stub + the real store. If this fails, nothing else in the folder means
// anything.
import {
  advance, FakeServer, flush, installFetch, mountView, realClock, useFakeClock,
} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { refreshConvo, resetConvos, useConvo } from '../src/convo'
import type { Convo } from '../src/convo'

function Probe({ slug, nid, sink }: { slug: string; nid: string; sink: Convo[] }) {
  const c = useConvo(slug, nid)
  sink.push(c)
  return <div data-testid="n">{String(c.chat?.messages.length ?? -1)}</div>
}

test('rig: the fetch stub and the store agree without React', async () => {
  useFakeClock()
  resetConvos()
  const s = new FakeServer()
  s.userMsg('hello')
  s.assistantMsg('hi there')
  installFetch(s)
  await refreshConvo('org', 'a')
  await flush()
  assert.equal(s.requests.length, 1)
  realClock()
})

test('rig: a mounted view fetches, renders and keeps polling', async () => {
  useFakeClock()
  resetConvos()
  const s = new FakeServer()
  s.userMsg('hello')
  s.assistantMsg('hi there')
  installFetch(s)
  const sink: Convo[] = []
  const v = await mountView(
    <Probe slug="org" nid="a" sink={sink} />, (el) => el.textContent)
  await flush()
  // ※ mounting alone does NOT fetch — `beat()` schedules the first poll one
  // BUSY_POLL_MS out, and the desk's own effect covers the gap. A view that
  // forgets that effect shows nothing for 2.5 s.
  await advance(3000)
  assert.equal(v.last(), '2', 'the first payload rendered')
  const before = s.requests.length
  await advance(20000)
  assert.ok(s.requests.length > before, 'the heartbeat keeps fetching')
  await v.unmount()
  const after = s.requests.length
  await advance(30000)
  assert.equal(s.requests.length, after, 'unmount stops the poll')
  realClock()
})
