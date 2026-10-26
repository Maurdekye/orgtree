/** RUNNING APP PANELS IN A WINDOW (user 2026-10-26: "just closing their visual
 *  doesnt stop them from running"; "No cap", shared process, CPU per panel).
 *
 *  A window that hosts running panels keeps its timers unthrottled, also while
 *  it is hidden in the tray or minimized, so hidden panels keep their loops.
 *  CPU is measured only when asked: each panel frame's own script time over a
 *  short window, attributed to a panel through the TRUSTED `data-orgtree-runtime`
 *  attribute on its owner iframe element, never through anything the panel's
 *  own document says. When that attribution is unavailable the hosting
 *  processes' CPU is reported, labelled shared, and never divided into invented
 *  per-panel figures. */
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

/** Owner identity from the parent's own DOM: `panel:generation`. */
function runtimeAttribute(attributes: string[] | undefined): string | null {
  if (!attributes) return null
  for (let i = 0; i + 1 < attributes.length; i += 2) if (attributes[i] === 'data-orgtree-runtime') return attributes[i + 1] ?? null
  return null
}

/** Percent of one core from two script-time readings (seconds) over wall time. */
export function scriptShare(before: number | undefined, after: number | undefined, seconds: number): number | null {
  if (before === undefined || after === undefined || !(seconds > 0)) return null
  return Math.round(Math.max(0, after - before) / seconds * 10000) / 100
}

/** Script time per panel frame. Chromium runs sandboxed panel frames out of
 *  process, each its own frame root with its own Performance metrics. Stack
 *  samples cannot tell copies apart: copies of one app share compiled scripts
 *  in their shared renderer process (measured 2026-10-26). Workers and frames
 *  in the page's own process stay unattributed (shared figure). */
async function sampleContents(contents: WebContents, wanted: Wanted[], ms: number): Promise<PanelCpuSample[] | null> {
  if (contents.isDestroyed() || contents.debugger.isAttached()) return null
  try { contents.debugger.attach('1.3') } catch { return null }
  const send: Send = (method, params = {}, session) => contents.debugger.sendCommand(method, params, session)
  const frames: { session: string; frame: string }[] = []
  const onMessage = (_event: unknown, method: string, params: any) => {
    if (method === 'Target.attachedToTarget' && params?.targetInfo?.type === 'iframe') frames.push({ session: params.sessionId, frame: params.targetInfo.targetId })
  }
  contents.debugger.on('message', onMessage)
  const owned = new Map<string, string>()   // session -> "panel:generation"
  try {
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    const want = new Set(wanted.map(w => `${w.panel}:${w.generation}`))
    for (const f of frames) {
      try {
        const ownerNode = await send('DOM.getFrameOwner', { frameId: f.frame })
        const described = await send('DOM.describeNode', { backendNodeId: ownerNode.backendNodeId })
        const id = runtimeAttribute(described?.node?.attributes)
        if (id && want.has(id)) owned.set(f.session, id)
      } catch { /* not an app panel frame */ }
    }
    if (!owned.size) return null
    const read = async (session: string) => {
      const { metrics } = await send('Performance.getMetrics', {}, session) as { metrics: { name: string; value: number }[] }
      return { at: Date.now(), script: metrics.find(m => m.name === 'ScriptDuration')?.value }
    }
    for (const session of owned.keys()) await send('Performance.enable', { timeDomain: 'threadTicks' }, session).catch(() => send('Performance.enable', {}, session))
    const before = new Map<string, Awaited<ReturnType<typeof read>>>()
    for (const session of owned.keys()) before.set(session, await read(session))
    await new Promise(resolve => setTimeout(resolve, ms))
    const measured = new Map<string, number>()
    for (const [session, id] of owned) {
      const a = before.get(session)!, b = await read(session)
      const cpu = scriptShare(a.script, b.script, (b.at - a.at) / 1000)
      if (cpu !== null) measured.set(id, cpu)
    }
    if (!measured.size) return null
    return wanted.map(w => {
      const cpu = measured.get(`${w.panel}:${w.generation}`)
      return cpu === undefined ? { ...w, cpu_percent: null, method: null } : { ...w, cpu_percent: cpu, method: 'sampled CPU' as const }
    })
  } catch { return null } finally {
    contents.debugger.removeListener('message', onMessage)
    for (const session of owned.keys()) await send('Performance.disable', {}, session).catch(() => {})
    try { contents.debugger.detach() } catch { /* already gone */ }
  }
}

/** The renderer processes that host this window's frames. Chromium may put
 *  sandboxed panel frames out of process, so the page's own process can miss them. */
function hostProcesses(contents: WebContents): number[] {
  const main = contents.mainFrame, pids = new Set<number>()
  for (const frame of main.framesInSubtree) if (frame !== main) pids.add(frame.osProcessId)
  if (!pids.size) pids.add(contents.getOSProcessId())
  return [...pids]
}

/** CPU of the processes hosting the window's frames, explicitly shared by every
 *  panel in them: cumulative CPU seconds over the window, so 100 = one core.
 *  getAppMetrics' percentCPUUsage averages since whichever call came before. */
async function sharedSamples(contents: WebContents, wanted: Wanted[], ms: number): Promise<PanelCpuSample[]> {
  const pids = contents.isDestroyed() ? [] : hostProcesses(contents)
  const used = () => {
    const seen = app.getAppMetrics().filter(m => pids.includes(m.pid) && m.cpu.cumulativeCPUUsage !== undefined)
    return seen.length ? seen.reduce((sum, m) => sum + (m.cpu.cumulativeCPUUsage ?? 0), 0) : null
  }
  const a = used(), start = Date.now()
  await new Promise(resolve => setTimeout(resolve, ms))
  const b = used(), seconds = (Date.now() - start) / 1000
  const cpu = a === null || b === null || seconds <= 0 ? null : Math.round(Math.max(0, b - a) / seconds * 10000) / 100
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
    if (missing.length && contents[0]) for (const s of await sharedSamples(contents[0], missing, ms)) merged.set(s.panel, s)
    return wanted.map(w => merged.get(w.panel) ?? { ...w, cpu_percent: null, method: null })
  })
  queue = run.catch(() => undefined)
  return run
}
