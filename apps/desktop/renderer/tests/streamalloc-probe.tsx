// Fixture for tools/run-alloc-probe.mjs — WHAT ONE STREAMED TOKEN COSTS.
//
// The ticket says the renderer allocates tens of megabytes per second to show
// a few kilobytes of agent output, and names three candidate sources without
// separating them: the per-token string rebuild in convo.ts, the whole-tree
// rebuilds on cache_forecast / mcp_tool_count, and React's own rendering.
// This probe separates them by running each ALONE in a real Electron renderer
// while the V8 sampling heap profiler attributes allocated bytes.
//
// WHAT IS REAL HERE: the real `ingestStream`, the real per-node convo store,
// the real `OwnedDeskChat` with the real markdown pipeline and the real
// stylesheet, the real `patchCacheNode`. The fixture supplies only a fetch
// stub for the chat payload and a synthetic token stream.
//
// EVERY SCENARIO DRIVES THE SAME NUMBER OF EVENTS AT THE SAME CADENCE, one
// macrotask apart, because React 18 batches updates that arrive inside one
// task: a tight synchronous loop would produce ONE commit for 400 tokens and
// report a cost the real app never pays. Real tokens arrive tens of
// milliseconds apart and each one gets its own commit.

import { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OwnedDeskChat } from '../src/canvas/desk'
import { md } from '../src/canvas/shared'
import { ingestStream, resetConvos, refreshConvo } from '../src/convo'
import { patchCacheNode } from '../src/App'
import type { CanvasNode } from '../src/canvas/shared'
import type { ChatMessage } from '../src/types'

const SLUG = 'orgtree'
const NID = 'probe-agent'
/** events driven per scenario — enough that per-event cost is well above the
 *  sampling interval's noise, few enough that a scenario runs in ~10 s */
const EVENTS = 250
/** the renderer's own cap on a live draft (convo.ts `slice(-12000)`) */
const DRAFT_CAP = 12000
/** Sampler calibration: 400 × 64 KB = 26 MB of exactly known allocation.
 *
 *  ⚠ THE SIZE IS CHOSEN AGAINST THE YOUNG GENERATION, which the runner sets
 *  to 64 MB. 26 MB fits inside it, so after the runner's collect no scavenge
 *  need run during the window — which is what makes the used-heap delta an
 *  EXACT figure for the retained variant rather than an estimate, and so what
 *  lets this scenario calibrate the precise instrument as well as the sampler.
 *  An earlier version used 96 MB and could not: it outgrew the window, the
 *  collections inside it were not counted, and it read 92× low. */
const SAMPLER_CHUNK = 65536
const SAMPLER_CHUNKS = 400
/** a token as the wire actually carries one: tens of bytes, not one char */
const TOKEN = 'the projection reconciles and the record is written back. '

// --------------------------------------------------------------- fixtures
/** Prose that costs what real prose costs: markdown structure, inline code
 *  and links. One long run of the same character wraps into far fewer text
 *  nodes than real text and would understate every measurement. */
function prose(bytes: number, seed: number): string {
  const out: string[] = []
  let n = 0, i = 0
  while (n < bytes) {
    const w = i % 9
    const chunk = w === 0 ? `\n## Section ${seed}.${i}\n`
      : w === 3 ? `- a list item with \`inline_code_${i}\` and a [link](https://example.invalid/${i})\n`
      : w === 6 ? `\n\`\`\`\nconst sample${i} = { key: ${i}, name: "value-${seed}" }\n\`\`\`\n`
      : `The quick brown fox ${i} jumps over the lazy dog while the record for agent-${seed} is projected and reconciled. `
    out.push(chunk); n += chunk.length; i++
  }
  return out.join('')
}

/** A transcript of the size a working agent's desk actually holds. The window
 *  the desk fetches is CHAT_WINDOW-bounded, so this is not unbounded history —
 *  it is one ordinary turn's worth of rows plus the tail of the previous. */
function transcript(rows: number): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let i = 0; i < rows; i++) {
    const at = new Date(Date.UTC(2026, 8, 16, 9, 0, i % 60)).toISOString()
    if (i % 5 === 0) {
      out.push({ role: 'user', seq: i, event_id: 'e' + i, row_id: 'r' + i, ts: at,
        text: prose(300, i) } as unknown as ChatMessage)
    } else if (i % 5 === 3) {
      out.push({ role: 'assistant', seq: i, event_id: 'e' + i, row_id: 'r' + i, ts: at,
        text: prose(500, i),
        tools: [{ id: 't' + i, name: 'orgtree_work', arg: 'list',
          result: prose(3000, i), result_lines: 50, event_id: 'te' + i,
          result_event_id: 'tr' + i }] } as unknown as ChatMessage)
    } else {
      out.push({ role: 'assistant', seq: i, event_id: 'e' + i, row_id: 'r' + i, ts: at,
        text: prose(1200, i) } as unknown as ChatMessage)
    }
  }
  return out
}

/** ⚠ A STRING THAT REALLY OCCUPIES ITS OWN LENGTH, which is harder than it
 *  looks and is worth the care because a calibration fixture that lies is
 *  worse than none.
 *
 *  `String(i).padEnd(65536, 'x')` looks like 64 KB and is not: V8 represents
 *  it as a rope over the small prefix and ONE shared run of the filler, so
 *  four hundred of them cost about four hundred kilobytes between them, not
 *  twenty-six megabytes. Measured in plain node, same engine: `padEnd` 402 KB
 *  for 400, built-and-flattened 26.85 MB for the same 400.
 *
 *  So: grow the string by concatenation and then `slice`, which forces V8 to
 *  flatten it into one sequential string of its own. The `i` in the head keeps
 *  every chunk distinct so nothing can be shared between them. */
const SAMPLER_FILL = 'z'.repeat(1024)
function bigString(i: number): string {
  let s = 'y' + i + '-'
  while (s.length < SAMPLER_CHUNK) s += SAMPLER_FILL
  return s.slice(0, SAMPLER_CHUNK)
}

function tree(nodes: number): CanvasNode {
  const children: CanvasNode[] = []
  for (let i = 0; i < nodes; i++) {
    children.push({ id: 'agent-' + i, state: 'live', tier: 'opus', children: [],
      title: 'agent ' + i, seat: 1, grant: 0,
      cache_forecast: null } as unknown as CanvasNode)
  }
  return { id: 'coordinator', state: 'live', tier: 'opus', children,
    title: 'coordinator' } as unknown as CanvasNode
}

const nodeFor = (id: string): CanvasNode => ({ id, state: 'live', tier: 'opus',
  children: [], title: id, seat: 1, grant: 0, generation: 0,
  proc_warm: true } as unknown as CanvasNode)
const NODE = nodeFor(NID)
const MAP = new Map<string, CanvasNode>([[NID, NODE]])

// ------------------------------------------------------------------- load
/** The load scenario's shape. A websocket does not wait for the renderer: it
 *  delivers at the agent's pace whether or not the last token has been drawn.
 *  So tokens are scheduled on WALL CLOCK, up front — when the main thread is
 *  blocked they queue and fire back to back, which is exactly the backlog the
 *  real app builds. Driving one token per macrotask instead would let the
 *  renderer set its own arrival rate and would measure a cost per token
 *  rather than a rate per second. */
const LOAD_AGENTS = 3
const LOAD_RATE = 40          // deltas per second per agent
const LOAD_MS = 8000
const LOAD_ROWS = 40          // transcript rows per desk

// ------------------------------------------------------------ fetch stub
/** The desk fetches its own payload. Answer the endpoints it reaches for and
 *  nothing else — an unstubbed call must fail loudly rather than hang. */
function installFetch(rows: ChatMessage[]): void {
  const payload = {
    busy: true, responding: true, queued: 0, last_error: null, occupancy: 1000,
    messages: rows, live: [], pending_mail: [], mail_pending: 0,
    transient: [], conversation_id: 'c1',
  }
  const json = (body: unknown): Promise<Response> => Promise.resolve(new Response(
    JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  window.fetch = ((input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input)
    if (url.includes('/chat')) return json(payload)
    if (url.includes('/work-items')) return json({ items: [], archived: [], backlogged: [] })
    if (url.includes('/documents')) return json({ documents: [] })
    return json({})
  }) as typeof window.fetch
}

// ---------------------------------------------------------------- mounts
let root: Root | null = null
let setForecast: ((n: number) => void) | null = null

function Desk({ node = NODE }: { node?: CanvasNode }) {
  return <div style={{ width: 900, height: 700 }}>
    <OwnedDeskChat node={node} map={MAP} slug={SLUG} pub={false}
      op={(() => Promise.resolve({ ok: true })) as never}
      toast={(() => {}) as never} />
  </div>
}

/** N desks side by side — the concurrent-agent case. Each has its own convo
 *  entry and its own subscriber, which is how the real canvas holds them. */
function Desks({ ids }: { ids: string[] }) {
  return <div style={{ display: 'flex' }}>
    {ids.map((id) => <Desk key={id} node={nodeFor(id)} />)}
  </div>
}

/** The tree-rebuild path, mounted: `patchCacheNode` rebuilds the spine of the
 *  tree and the new root identity re-renders whatever reads it. The consumer
 *  here is deliberately small — it renders one line per node — so this
 *  scenario measures the REBUILD, which is what the ticket names, and does
 *  not smuggle the whole canvas's per-frame spring cost into the number. */
function TreeHost({ nodes }: { nodes: number }) {
  const [t, setT] = useState<CanvasNode>(() => tree(nodes))
  useEffect(() => {
    setForecast = (i: number) => setT((old) => patchCacheNode(
      old, 'agent-' + (i % nodes),
      { state: 'warm', until: 1000 + i } as never))
    return () => { setForecast = null }
  }, [nodes])
  const render = (n: CanvasNode): JSX.Element => <div key={n.id} className="node">
    <span>{n.title}</span><span>{n.cache_forecast ? 'warm' : '—'}</span>
    {n.children.map(render)}
  </div>
  return <div>{render(t)}</div>
}

function unmount(): void {
  if (root) { root.unmount(); root = null }
  resetConvos()
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const task = () => new Promise<void>((r) => setTimeout(r, 0))
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ------------------------------------------------------------- allocation
/** HOW MANY BYTES THE RENDERER ALLOCATED, not how many it is holding.
 *
 *  The ticket's defect is invisible to every retained-size tool: nothing is
 *  kept, the collector reclaims it all, and the process still dies because it
 *  cannot keep up. So the number to take is the SUM OF POSITIVE DELTAS in the
 *  used heap, sampled once per event — every rise is allocation, and a fall is
 *  a collection, which is skipped rather than subtracted.
 *
 *  Two conditions make that sum exact rather than approximate, and the runner
 *  supplies both: `--enable-precise-memory-info`, without which usedJSHeapSize
 *  is quantised to 100 KB buckets, and a 64 MB young generation, which is
 *  larger than any one phase allocates — so `drops` should come back 0 and a
 *  nonzero one is a warning that the phase outgrew the window and the figure
 *  is a lower bound. */
interface Mem { usedJSHeapSize: number }
const heap = (): number =>
  (performance as unknown as { memory?: Mem }).memory?.usedJSHeapSize ?? 0

class Alloc {
  private last = 0
  private first = 0
  private peak = 0
  bytes = 0
  drops = 0
  samples = 0
  start(): void {
    this.bytes = 0; this.drops = 0; this.samples = 0
    this.last = this.first = this.peak = heap()
  }
  /** call after each event, and once more at the end */
  sample(): void {
    const now = heap()
    const d = now - this.last
    if (d > 0) this.bytes += d
    else if (d < 0) this.drops++
    if (now > this.peak) this.peak = now
    this.last = now
    this.samples++
  }
  report(events: number) {
    return { bytes: this.bytes, drops: this.drops, samples: this.samples,
      // raw readings, so a scenario whose arithmetic is known can say whether
      // the instrument moved at all — a sum of deltas that stays flat while a
      // known allocation is retained means the reading is not live, and no
      // amount of careful summing fixes that
      heapStart: this.first, heapPeak: this.peak, heapEnd: this.last,
      perEvent: events ? Math.round(this.bytes / events) : null }
  }
}
const alloc = new Alloc()

// -------------------------------------------------------------- scenarios
const SCENARIOS = [
  'sampler-retained', 'sampler-dropped',
  'load-concurrent', 'liveness-light', 'liveness',
  'control-strings', 'control-md',
  'store-delta', 'desk-idle', 'desk-bare-delta', 'desk-delta', 'desk-thinking',
  'tree-forecast',
] as const
type Scenario = typeof SCENARIOS[number]

let seq = 0
/** kept alive across the sampling window so nothing under test is optimised
 *  away as dead, and so the measured allocation is not quietly reclaimed
 *  mid-window by a scavenge that the real app would also do */
let sink: unknown[] = []

const api = {
  scenarios: () => [...SCENARIOS],

  async setup(name: Scenario) {
    unmount()
    seq = 0
    sink = []
    const host = document.getElementById('root')!
    document.title = 'setup:' + name
    if (name === 'sampler-retained' || name === 'sampler-dropped') {
      return { mounted: false, chunks: SAMPLER_CHUNKS,
        expectBytes: SAMPLER_CHUNKS * SAMPLER_CHUNK }
    }
    if (name === 'control-strings' || name === 'control-md') {
      // CALIBRATION. `control-strings` allocates a known quantity by the same
      // concat-then-slice shape convo.ts uses, so the profiler's reported
      // total can be checked against arithmetic before any conclusion is drawn
      // from it. `control-md` runs the REAL markdown pipeline over a draft
      // that grows one token at a time — the work one streamed token causes
      // inside a mounted desk, with React and the DOM taken out of it.
      return { mounted: false, expectBytes: name === 'control-strings'
        ? EVENTS * DRAFT_CAP * 2 : null }
    }
    if (name === 'store-delta') {
      // no React at all: the convo store with nobody subscribed. What is left
      // is exactly the string concat, the slice and the state object.
      return { mounted: false }
    }
    if (name === 'tree-forecast') {
      root = createRoot(host)
      root.render(<TreeHost nodes={20} />)
      await frame(); await frame()
      return { mounted: true, nodes: 20 }
    }
    if (name === 'load-concurrent' || name === 'liveness' || name === 'liveness-light') {
      installFetch(transcript(LOAD_ROWS))
      const ids = Array.from({ length: name === 'liveness-light' ? 1 : LOAD_AGENTS },
        (_, i) => 'agent-' + i)
      root = createRoot(host)
      root.render(<Desks ids={ids} />)
      await frame(); await frame()
      for (const id of ids) await refreshConvo(SLUG, id, { force: true }).catch(() => {})
      await wait(500)
      await frame()
      return { mounted: true, agents: LOAD_AGENTS, rate: LOAD_RATE,
        seconds: LOAD_MS / 1000, rows: LOAD_ROWS,
        domNodes: host.querySelectorAll('*').length }
    }
    // `desk-bare-delta` mounts the same desk with an EMPTY transcript. The
    // difference between it and `desk-delta` is the part of a token's cost
    // that scales with what is already on screen rather than with the token.
    installFetch(transcript(name === 'desk-bare-delta' ? 0 : 40))
    root = createRoot(host)
    root.render(<Desk />)
    await frame(); await frame()
    await refreshConvo(SLUG, NID, { force: true }).catch(() => {})
    await wait(300)
    await frame()
    return { mounted: true,
      domNodes: host.querySelectorAll('*').length,
      rows: host.querySelectorAll('[data-reply-event]').length }
  },

  /** Quiet time — the control for every timer, poll and animation the mounted
   *  surface runs whether or not anything is streaming. `desk-idle` reports
   *  it as its own scenario so the streaming numbers can be read net of it. */
  idle(ms: number) { return wait(ms) },

  async run(name: Scenario) {
    document.title = 'run:' + name
    const t0 = performance.now()
    alloc.start()
    const done = (events: number) => {
      alloc.sample()
      const ms = performance.now() - t0
      return { events, ms: Math.round(ms), ...alloc.report(events),
        bytesPerSec: Math.round(alloc.bytes / (ms / 1000)),
        msPerEvent: events ? +(ms / events).toFixed(2) : null }
    }
    if (name === 'liveness' || name === 'liveness-light') {
      // DOES IT STILL LOOK LIVE? Not "did the store update" — did the WORDS
      // reach the screen, and how long after the websocket delivered them.
      //
      // Each token carries a marker. On every painted frame the probe reads
      // the highest marker actually present in the draft's DOM text and
      // charges the wait to the moment the WIRE WOULD HAVE DELIVERED that
      // token — its scheduled instant, not the moment the renderer got round
      // to ingesting it. Charging from ingest would flatter a renderer that is
      // behind: it would hide the queue and report only the last hop. What
      // comes back is therefore lag behind the AGENT, which is what the ticket
      // asks about, and it includes React's commit and the browser's paint.
      //
      // `liveness-light` is one desk at an ordinary streaming rate — the
      // question "does coalescing add visible delay in the normal case".
      // `liveness` is three saturated desks — "and what happens under the load
      // that actually kills the renderer".
      const light = name === 'liveness-light'
      const agents = light ? 1 : LOAD_AGENTS
      const rate = light ? 30 : LOAD_RATE
      const ms = light ? 5000 : LOAD_MS
      const ids = Array.from({ length: agents }, (_, i) => 'agent-' + i)
      const at = new Map<number, number>()
      const seen: number[] = []
      const commits: number[] = []
      const mark = /#(\d+)#/g
      // ⚠ A MUTATION OBSERVER, NOT requestAnimationFrame. The probe window is
      // created hidden, and a window with no compositor does not schedule
      // animation frames at display rate — so rAF here measures the probe's
      // own throttling, not the renderer's. A DOM mutation is not throttled:
      // it fires when React COMMITS the new text, which is one paint away from
      // what the eye sees and is the honest thing to measure from a headless
      // window. Read as "how far behind the agent the committed DOM is".
      const obs = new MutationObserver(() => {
        const now = performance.now()
        commits.push(now)
        for (const el of document.querySelectorAll('.md.draft')) {
          const text = el.textContent ?? ''
          let best = -1, m: RegExpExecArray | null
          mark.lastIndex = 0
          while ((m = mark.exec(text))) best = Math.max(best, Number(m[1]))
          const t = at.get(best)
          if (t !== undefined) { seen.push(now - t); at.delete(best) }
        }
      })
      obs.observe(document.getElementById('root')!,
        { subtree: true, childList: true, characterData: true })
      const gap = 1000 / rate
      const wire = performance.now()
      let n = 0
      const pending: Promise<void>[] = []
      for (let i = 0; i * gap < ms; i++) {
        for (const id of ids) {
          const tag = n++
          at.set(tag, wire + i * gap)     // when the wire would have delivered it
          pending.push(new Promise<void>((r) => setTimeout(() => {
            ingestStream(SLUG, { node: id, kind: 'delta',
              text: `#${tag}# `, event_id: 'draft-' + id } as never)
            alloc.sample()
            r()
          }, i * gap)))
        }
      }
      await Promise.all(pending)
      await wait(400)
      obs.disconnect()
      const sorted = [...seen].sort((a, b) => a - b)
      const pick = (q: number) => sorted.length
        ? +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!).toFixed(1) : null
      // the longest the screen went without changing at all — a stream that
      // arrives in visible jumps shows up here, where an average would hide it
      let worstGap = 0
      for (let i = 1; i < commits.length; i++) {
        worstGap = Math.max(worstGap, commits[i]! - commits[i - 1]!)
      }
      const r = done(n)
      return { ...r, agents, rate, commits: commits.length,
        commitsPerSec: +(commits.length / (r.ms / 1000)).toFixed(1),
        worstGapMs: +worstGap.toFixed(1),
        measured: sorted.length,
        lagMedian: pick(0.5), lagP95: pick(0.95),
        lagMax: sorted.length ? +sorted[sorted.length - 1]!.toFixed(1) : null }
    }
    if (name === 'load-concurrent') {
      // THE HEADLINE MEASUREMENT. Every token is scheduled up front against
      // the wall clock, so the renderer cannot slow the stream down to a rate
      // it can afford — which is the whole shape of the defect.
      const ids = Array.from({ length: LOAD_AGENTS }, (_, i) => 'agent-' + i)
      const gap = 1000 / LOAD_RATE
      let delivered = 0
      const pending: Promise<void>[] = []
      for (let i = 0; i * gap < LOAD_MS; i++) {
        for (const id of ids) {
          pending.push(new Promise<void>((r) => setTimeout(() => {
            ingestStream(SLUG, { node: id, kind: 'delta',
              text: TOKEN + (seq++) + ' ', event_id: 'draft-' + id } as never)
            delivered++
            alloc.sample()
            r()
          }, i * gap)))
        }
      }
      await Promise.all(pending)
      await frame()
      const r = done(delivered)
      return { ...r, scheduled: pending.length,
        // the renderer's real throughput: if this is far below the offered
        // rate the desk is behind the agent, which is the user-visible half
        deliveredPerSec: Math.round(delivered / (r.ms / 1000)) }
    }
    if (name === 'sampler-retained' || name === 'sampler-dropped') {
      // ⚠ IS THE SAMPLING PROFILER A RATE INSTRUMENT OR A RETENTION ONE?
      //
      // The two scenarios allocate the SAME known quantity by the SAME code
      // path and differ in one thing: whether the result is kept. Both end
      // with an explicit collection, so anything dropped is genuinely gone
      // before the profile is read.
      //
      //   · a uniformly lossy sampler reports the same total for both;
      //   · an instrument that reports only what SURVIVED reports the full
      //     amount for `retained` and near nothing for `dropped`.
      //
      // MEASURED, 2026-09-16, and it is the second: 26,446,680 sampled bytes
      // when the result is kept, 3,452 when it is dropped — a factor of seven
      // thousand for identical allocation. So `sampledBytes` is a RETENTION
      // figure and the spread across this probe's scenarios is survival rate,
      // not sampling error. The same pair validates the precise instrument,
      // which reported ~34.5 MB for both, as it must.
      let checksum = 0
      for (let i = 0; i < SAMPLER_CHUNKS; i++) {
        const chunk = bigString(i)
        checksum += chunk.length
        if (name === 'sampler-retained') sink.push(chunk)
        // once per chunk, exactly as the streaming scenarios sample once per
        // event — a coarser cadence lets a collection hide allocation between
        // samples and reads low for reasons that have nothing to do with the
        // instrument being wrong
        await task(); alloc.sample()
      }
      ;(window as unknown as { gc?: () => void }).gc?.()
      return { ...done(SAMPLER_CHUNKS), checksum,
        retained: name === 'sampler-retained' }
    }
    if (name === 'control-strings') {
      let draft = ''
      for (let i = 0; i < EVENTS; i++) {
        draft = (draft + TOKEN + i + ' ').slice(-DRAFT_CAP)
        sink.push(draft.length)
        await task(); alloc.sample()
      }
      return done(EVENTS)
    }
    if (name === 'control-md') {
      let draft = ''
      for (let i = 0; i < EVENTS; i++) {
        draft = (draft + TOKEN + i + ' ').slice(-DRAFT_CAP)
        // the length only: `md` retains its own result in its LRU, and the
        // probe must not add retention the real app does not have
        sink.push(md(draft, 'probe', true).__html.length)
        await task(); alloc.sample()
      }
      return done(EVENTS)
    }
    if (name === 'desk-idle') {
      for (let i = 0; i < 100; i++) { await wait(50); alloc.sample() }
      return done(0)
    }
    if (name === 'tree-forecast') {
      for (let i = 0; i < EVENTS; i++) { setForecast?.(i); await task(); alloc.sample() }
      await frame()
      return done(EVENTS)
    }
    const kind = name === 'desk-thinking' ? 'thinking' : 'delta'
    if (kind === 'thinking') {
      ingestStream(SLUG, { node: NID, kind: 'thinking_start', text: '',
        event_id: 'think-1' } as never)
    }
    for (let i = 0; i < EVENTS; i++) {
      ingestStream(SLUG, { node: NID, kind, text: TOKEN + (seq++) + ' ',
        event_id: kind === 'thinking' ? 'think-1' : 'draft-1' } as never)
      await task(); alloc.sample()
    }
    await frame()
    return done(EVENTS)
  },
}

;(window as unknown as { __alloc: typeof api }).__alloc = api
document.title = 'ready'
