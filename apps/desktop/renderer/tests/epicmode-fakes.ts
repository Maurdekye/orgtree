// Test doubles for EPIC Mode's suites: a counting AudioContext whose nodes
// accept every call the synth makes, and a quiet canvas.
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
// exactly what these suites want, so answer null quietly.
;(window.HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null
