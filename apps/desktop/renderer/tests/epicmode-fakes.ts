// Test doubles for EPIC Mode's suites: a counting AudioContext whose nodes
// accept every call the synth makes, a quiet canvas, and a clock the test
// moves by hand.
//
// jsdom has no Web Audio and no canvas drawing. The fake records how many
// contexts were built and closed and how many nodes were created, which is
// how a test sees that a sound was really synthesized (or that none was).

export interface AudioLog { created: number; closed: number; nodes: number; started: number }

type Anything = Record<string | symbol, unknown>

/** an AudioParam-or-node stand-in: methods are no-ops, properties remember */
function fakeNode(log: AudioLog): Anything {
  const store: Anything = {}
  const param = () => {
    const p: Anything = { value: 0 }
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime',
      'setTargetAtTime', 'cancelScheduledValues']) p[m] = () => p
    return p
  }
  return new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key]
      if (key === 'connect' || key === 'disconnect') return () => undefined
      if (key === 'start') return () => { log.started++ }
      if (key === 'stop') return () => undefined
      if (key === 'then') return undefined
      const p = param()
      target[key] = p
      return p
    },
    set(target, key, value) { target[key] = value; return true },
  })
}

export function fakeAudio(): { Ctor: new () => AudioContext; log: AudioLog } {
  const log: AudioLog = { created: 0, closed: 0, nodes: 0, started: 0 }
  class FakeAudioContext {
    currentTime = 0
    sampleRate = 8000
    state: AudioContextState = 'running'
    destination = fakeNode(log)
    constructor() { log.created++ }
    private node() { log.nodes++; return fakeNode(log) }
    createGain() { return this.node() }
    createOscillator() { return this.node() }
    createBiquadFilter() { return this.node() }
    createBufferSource() { return this.node() }
    createDynamicsCompressor() { return this.node() }
    createConvolver() { return this.node() }
    createStereoPanner() { return this.node() }
    createWaveShaper() { return this.node() }
    createBuffer(channels: number, length: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return { numberOfChannels: channels, length, getChannelData: (c: number) => data[c] }
    }
    resume() { return Promise.resolve() }
    close() { log.closed++; this.state = 'closed'; return Promise.resolve() }
  }
  return { Ctor: FakeAudioContext as unknown as new () => AudioContext, log }
}

// The director watches the app feed for usage readings. Answer its capability
// probe as a legacy engine does (501: no socket, no retries) and refuse any
// other request, so nothing here ever reaches a real network.
;(globalThis as unknown as { fetch: typeof fetch }).fetch = ((input: RequestInfo | URL) =>
  new URL(String(input), 'http://localhost').pathname === '/api/app/records'
    ? Promise.resolve(new Response(JSON.stringify({ detail: 'fixture: legacy engine' }), { status: 501 }))
    : Promise.reject(new Error(`unexpected fetch ${String(input)}`))) as typeof fetch

// jsdom logs "Not implemented: HTMLCanvasElement.prototype.getContext" on
// every call; the stage treats a missing context as "draw nothing", which is
// exactly what most of these suites want, so answer null quietly.
const quiet = () => null
;(window.HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = quiet

/** The stage's time, taken over: `performance.now` reads a clock the test
 *  moves, and the window's requestAnimationFrame and setTimeout run only when
 *  it does (`run`: due timers first, then the frames asked for, at 60 Hz), so
 *  half a minute of lingering effects takes no real time and a test can count
 *  the frames the loop drew. `skip` moves the clock with nothing running, as
 *  for a window the system has hidden. Undo with `restore`. */
export interface Clock {
  readonly now: number
  /** frames run so far */
  readonly frames: number
  /** a frame or a timer is waiting: false once the loop sleeps */
  readonly busy: boolean
  run(ms: number): void
  skip(ms: number): void
  restore(): void
}

export function clockwork(): Clock {
  const w = window as unknown as Record<string, unknown>
  const perf = performance as unknown as Record<string, unknown>
  const names = ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'] as const
  const had = names.map(n => Object.getOwnPropertyDescriptor(w, n))
  const hadNow = Object.getOwnPropertyDescriptor(perf, 'now')
  let now = 100_000, frames = 0, ids = 0
  let pending = new Map<number, (t: number) => void>()
  const timers = new Map<number, { due: number; fn: () => void }>()
  const put = (key: string, value: unknown) => Object.defineProperty(w, key, { value, configurable: true, writable: true })
  put('requestAnimationFrame', (cb: (t: number) => void) => { pending.set(++ids, cb); return ids })
  put('cancelAnimationFrame', (id: number) => { pending.delete(id) })
  put('setTimeout', (fn: () => void, ms = 0) => { timers.set(++ids, { due: now + Number(ms), fn }); return ids })
  put('clearTimeout', (id: number) => { timers.delete(id) })
  Object.defineProperty(perf, 'now', { value: () => now, configurable: true, writable: true })
  return {
    get now() { return now },
    get frames() { return frames },
    get busy() { return pending.size > 0 || timers.size > 0 },
    run(ms: number) {
      const end = now + ms
      while (now < end) {
        now = Math.min(end, now + 1000 / 60)
        const due = [...timers].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due)
        for (const [id, t] of due) { if (timers.delete(id)) t.fn() }
        const run = pending
        pending = new Map()
        for (const cb of run.values()) { frames++; cb(now) }
      }
    },
    skip(ms: number) { now += ms },
    restore() {
      names.forEach((n, i) => { const d = had[i]; if (d) Object.defineProperty(w, n, d); else delete w[n] })
      if (hadNow) Object.defineProperty(perf, 'now', hadNow); else delete perf.now
    },
  }
}

/** A 2D context that records every drawing call (method name, and the text of
 *  fillText/strokeText) instead of drawing, for asserting that an effect
 *  really put something on the stage. Undo with `restore`. */
export function recordCanvas(): { calls: string[]; texts: string[]; restore: () => void } {
  const calls: string[] = [], texts: string[] = []
  const DRAW = new Set(['fill', 'stroke', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText', 'arc', 'ellipse', 'lineTo'])
  const context = () => {
    const store: Record<string | symbol, unknown> = {}
    const gradient = () => ({ addColorStop: () => undefined })
    return new Proxy(store, {
      get(target, key) {
        if (key in target) return target[key]
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return gradient
        if (key === 'measureText') return (t: string) => ({ width: String(t).length * 7 })
        if (key === 'then') return undefined
        return (...args: unknown[]) => {
          const name = String(key)
          if (DRAW.has(name)) calls.push(name)
          if ((name === 'fillText' || name === 'strokeText') && typeof args[0] === 'string') texts.push(args[0])
          return undefined
        }
      },
      set(target, key, value) { target[key] = value; return true },
    })
  }
  const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }
  proto.getContext = context
  return { calls, texts, restore: () => { proto.getContext = quiet } }
}
