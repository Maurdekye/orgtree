/** RUNNING APP PANELS IN A WINDOW (user 2026-10-26: "just closing their visual
 *  doesnt stop them from running"; "No cap", shared process, CPU per panel).
 *
 *  A window that hosts running panels keeps its timers unthrottled, also while
 *  it is hidden in the tray or minimized, so hidden panels keep their loops.
 *  CPU is measured only when asked: a short V8 sampling profile, attributed to
 *  a panel through the TRUSTED `data-orgtree-runtime` attribute on its owner
 *  iframe element, never through anything the panel's own document says. When
 *  that attribution is unavailable the owner process's CPU is reported,
 *  labelled shared, and never divided into invented per-panel figures. */
import { app, type WebContents } from 'electron'
import type { PanelCpuSample } from '../../../packages/contracts/index'
interface Wanted { panel: string; generation: number }

/** Validates the renderer's count; native never trusts it beyond a number. */
export function panelCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0
}

/** The renderer's list of hosts it wants measured, bounded and shape-checked. */
export function wantedPanels(value: unknown): Wanted[] {
  if (!Array.isArray(value) || value.length > 4096) return []
  return value.filter((v): v is Wanted => !!v && typeof v === 'object' && typeof (v as Wanted).panel === 'string'
    && (v as Wanted).panel.length > 0 && (v as Wanted).panel.length <= 120 && Number.isInteger((v as Wanted).generation))
}

type Send = (method: string, params?: Record<string, unknown>, session?: string) => Promise<any>
interface CpuNode { id: number; callFrame: { scriptId: string }; children?: number[] }
interface Profile { nodes: CpuNode[]; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }

/** Microseconds of sampled main-thread JS per frame, walking from each sampled
 *  node up to the nearest script that belongs to a known frame, so builtins
 *  called by a panel count for that panel. Idle, GC and program time stay
 *  unattributed: a shared heap cannot be charged to one copy. */
export function attribute(profile: Profile, scriptFrame: Map<string, string>): Map<string, number> {
  const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map<number, number>()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const owner = new Map<number, string | null>()
  const frameOf = (id: number): string | null => {
    if (owner.has(id)) return owner.get(id)!
    const path: number[] = []; let at: number | undefined = id, found: string | null = null
    while (at !== undefined) {
      if (owner.has(at)) { found = owner.get(at)!; break }
      path.push(at)
      const frame = scriptFrame.get(byId.get(at)?.callFrame.scriptId ?? '')
      if (frame) { found = frame; break }
      at = parent.get(at)
    }
    for (const p of path) owner.set(p, found)
    return found
  }
  const out = new Map<string, number>(), samples = profile.samples ?? [], deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const frame = frameOf(samples[i]!), delta = Math.max(0, deltas[i] ?? 0)
    if (frame) out.set(frame, (out.get(frame) ?? 0) + delta)
  }
  return out
}

/** Owner identity from the parent's own DOM: `panel:generation`. */
function runtimeAttribute(attributes: string[] | undefined): string | null {
  if (!attributes) return null
  for (let i = 0; i + 1 < attributes.length; i += 2) if (attributes[i] === 'data-orgtree-runtime') return attributes[i + 1] ?? null
  return null
}

async function sampleContents(contents: WebContents, wanted: Wanted[], ms: number): Promise<PanelCpuSample[] | null> {
  if (contents.isDestroyed() || contents.debugger.isAttached()) return null
  try { contents.debugger.attach('1.3') } catch { return null }
  const send: Send = (method, params = {}, session) => contents.debugger.sendCommand(method, params, session)
  const scripts = new Map<string, Map<string, string>>()   // session -> scriptId -> frameId
  const sessions: { id: string | undefined; targetId?: string; type: string }[] = [{ id: undefined, type: 'page' }]
  const onMessage = (_event: unknown, method: string, params: any, sessionId?: string) => {
    if (method === 'Debugger.scriptParsed') {
      const frame = params?.executionContextAuxData?.frameId
      if (typeof frame === 'string') {
        const key = sessionId ?? ''
        if (!scripts.has(key)) scripts.set(key, new Map())
        scripts.get(key)!.set(params.scriptId, frame)
      }
    } else if (method === 'Target.attachedToTarget' && params?.targetInfo?.type === 'iframe') {
      sessions.push({ id: params.sessionId, targetId: params.targetInfo.targetId, type: 'iframe' })
    }
  }
  contents.debugger.on('message', onMessage)
  try {
    // Out-of-process frames, if Chromium isolated the sandboxed panels, are
    // their own targets. Workers are not attributed per panel in this slice.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 50))
    const frames = new Map<string, string>()   // frameId -> "panel:generation"
    const tree = await send('Page.getFrameTree')
    const frameIds: string[] = []
    const walk = (node: any) => { for (const child of node?.childFrames ?? []) { frameIds.push(child.frame.id); walk(child) } }
    walk(tree?.frameTree)
    for (const s of sessions) if (s.targetId) frameIds.push(s.targetId)
    for (const frameId of frameIds) {
      try {
        const ownerNode = await send('DOM.getFrameOwner', { frameId })
        const described = await send('DOM.describeNode', { backendNodeId: ownerNode.backendNodeId })
        const id = runtimeAttribute(described?.node?.attributes)
        if (id) frames.set(frameId, id)
      } catch { /* not an app panel frame */ }
    }
    const want = new Set(wanted.map(w => `${w.panel}:${w.generation}`))
    if (![...frames.values()].some(v => want.has(v))) return null
    for (const s of sessions) {
      await send('Debugger.enable', {}, s.id)
      await send('Profiler.enable', {}, s.id)
      await send('Profiler.setSamplingInterval', { interval: 500 }, s.id)
    }
    for (const s of sessions) await send('Profiler.start', {}, s.id)
    await new Promise(resolve => setTimeout(resolve, ms))
    const totals = new Map<string, number>()
    let span = 0
    for (const s of sessions) {
      const { profile } = await send('Profiler.stop', {}, s.id) as { profile: Profile }
      span = Math.max(span, profile.endTime - profile.startTime)
      // An out-of-process panel frame's scripts may report no frame of their
      // own; the whole target is then that one frame.
      const map = new Map(scripts.get(s.id ?? '') ?? [])
      if (s.targetId && !map.size) for (const n of profile.nodes) map.set(n.callFrame.scriptId, s.targetId)
      for (const [frame, us] of attribute(profile, map)) {
        const id = frames.get(frame)
        if (id) totals.set(id, (totals.get(id) ?? 0) + us)
      }
    }
    if (span <= 0) return null
    return wanted.map(w => {
      const key = `${w.panel}:${w.generation}`
      if (![...frames.values()].includes(key)) return { ...w, cpu_percent: null, method: null }
      return { ...w, cpu_percent: Math.round((totals.get(key) ?? 0) / span * 10000) / 100, method: 'sampled CPU' as const }
    })
  } catch { return null } finally {
    contents.debugger.removeListener('message', onMessage)
    for (const s of sessions) { await send('Profiler.disable', {}, s.id).catch(() => {}); await send('Debugger.disable', {}, s.id).catch(() => {}) }
    try { contents.debugger.detach() } catch { /* already gone */ }
  }
}

/** Owner-process CPU, explicitly shared by every panel in that process. */
function sharedSamples(contents: WebContents, wanted: Wanted[]): PanelCpuSample[] {
  const pid = contents.isDestroyed() ? 0 : contents.getOSProcessId()
  const metric = app.getAppMetrics().find(m => m.pid === pid)
  const cpu = metric ? Math.round(metric.cpu.percentCPUUsage * 100) / 100 : null
  return wanted.map(w => ({ ...w, cpu_percent: cpu, method: cpu === null ? null : 'shared process CPU' as const }))
}

let queue: Promise<unknown> = Promise.resolve()
/** One sampling profile at a time across the app, in request order. */
export function samplePanels(contents: WebContents[], raw: unknown, ms = 1000): Promise<PanelCpuSample[]> {
  const wanted = wantedPanels(raw)
  if (!wanted.length) return Promise.resolve([])
  const run = queue.then(async () => {
    const merged = new Map<string, PanelCpuSample>()
    for (const c of contents) {
      const left = wanted.filter(w => !merged.get(w.panel)?.method)
      if (!left.length) break
      for (const s of await sampleContents(c, left, ms) ?? []) if (s.method) merged.set(s.panel, s)
    }
    const missing = wanted.filter(w => !merged.has(w.panel))
    if (missing.length && contents[0]) for (const s of sharedSamples(contents[0], missing)) merged.set(s.panel, s)
    return wanted.map(w => merged.get(w.panel) ?? { ...w, cpu_percent: null, method: null })
  })
  queue = run.catch(() => undefined)
  return run
}
