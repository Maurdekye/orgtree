import { mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hostPanel, samplePanels, usePanelCpu } from '../src/canvas/apps/runtime'

// 4.5.0 hands-on (2026-10-28, packaged alpha.8): opening the Apps list while no
// panel ran sampled nothing, and every later sample in that window was skipped,
// so the running list never showed CPU (USER 2026-10-26: CPU per panel in the
// running list). A run that returned before its first await cleared the
// in-flight slot synchronously and was then stored over it, never to clear.
type Wanted = { panel: string; generation: number }

function desktopStub(t: import('node:test').TestContext) {
  const calls: Wanted[][] = []
  const w = window as unknown as { orgtreeDesktop?: unknown }
  const old = { desktop: w.orgtreeDesktop, fetch: globalThis.fetch }
  w.orgtreeDesktop = {
    samplePanels: async (panels: Wanted[]) => { calls.push(panels); return panels.map(p => ({ ...p, cpu_percent: 1.5, method: 'sampled CPU' })) },
    setPanelRuntime: async () => {},
  }
  globalThis.fetch = (async () => new Response(JSON.stringify({ stop: [], sample_epoch: 0 }),
    { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  t.after(() => { w.orgtreeDesktop = old.desktop; globalThis.fetch = old.fetch })
  return calls
}

function Cpu({ org, panel }: { org: string; panel: string }) {
  const cpu = usePanelCpu(org).get(panel)
  return <span id="cpu">{cpu ? `${cpu.cpu} ${cpu.method}` : 'none'}</span>
}

test('a sample taken while nothing runs leaves later samples free: the running panel gets its CPU', async t => {
  const calls = desktopStub(t)
  const org = 'cpu-empty-first'
  await samplePanels(org)                       // the Apps list opens with nothing running
  const release = hostPanel(org, 'board', 3, () => {})
  t.after(release)
  await samplePanels(org)                       // a panel runs now; the list samples again
  assert.deepEqual(calls, [[{ panel: 'board', generation: 3 }]], 'the running panel reaches the desktop sampler')
  const view = await mountView(<Cpu org={org} panel="board" />, el => el)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('#cpu')?.textContent, '1.5 sampled CPU')
})

test('CONTROL: one sample at a time while a run is in flight; the next tick samples again', async t => {
  const calls = desktopStub(t)
  const org = 'cpu-inflight'
  const release = hostPanel(org, 'board', 1, () => {})
  t.after(release)
  const first = samplePanels(org), second = samplePanels(org)
  assert.equal(first, second, 'a tick during a run joins it')
  await first
  await samplePanels(org)
  assert.equal(calls.length, 2, 'after the run settles, the next tick samples again')
})
