/* EPIC Mode — the sound half.

   EVERY SOUND IS SYNTHESIZED HERE, AT PLAY TIME, from oscillators, filtered
   noise and envelopes (Web Audio). The repository is public, so there is no
   recorded, sampled or third-party audio anywhere in EPIC Mode: the noise is
   Math.random, the reverb's impulse response is generated decaying noise, and
   the material impacts and machine processes are original synthesis.

   One AudioContext per window, created only when EPIC Mode turns on and
   closed when it turns off. Everything runs through one bus: a dry path and a
   generated-reverb send meet in a compressor that works as the limiter, so a
   busy organization becomes a wall of sound rather than clipping.

   ⚠ A CACOPHONY HAS A BUDGET. Each play is a voice that lives until its
   envelope ends; past VOICE_CAP the cheap, frequent sounds (clicks, typing,
   ticks) are dropped first and only the loud events still get through, so a
   flood of events cannot pile thousands of live nodes onto the audio thread. */

import { ActivityAudio } from './ambience'
import type { ActivityCounts } from './activity'
import { toolVoice } from './toolvoice'

export type SoundName =
  | 'zap' | 'ice' | 'thaw' | 'stop' | 'halt' | 'resume' | 'hire' | 'retire'
  | 'move' | 'reorder' | 'turnStart' | 'turnEnd' | 'tool' | 'toolDone'
  | 'error' | 'send' | 'notice' | 'stamp' | 'victory' | 'docketMove'
  | 'drop' | 'question' | 'answer' | 'siren' | 'bark' | 'powerFail'
  | 'tick' | 'clack' | 'click' | 'type' | 'enter' | 'compact' | 'slots'
  | 'tada' | 'whirr' | 'coins' | 'epicOn' | 'epicOff' | 'whooshIn'
  | 'whooshOut' | 'boom' | 'thunder' | 'warp' | 'grab' | 'thud' | 'chime'
  | 'shimmer' | 'wake' | 'sleep' | 'glass' | 'scribble' | 'blip'
  // the final version's additions (docs/rust-engine/epic-mode-final.md)
  | 'note' | 'confirm' | 'refused' | 'maxed' | 'ping'
  // urgent mail's alarm, one cycle of it (the director repeats it)
  | 'klaxon'

export interface PlayOptions {
  tool?: string
  /** -1 (left) … 1 (right): where on screen the effect happened */
  pan?: number
  /** a multiplier on every frequency, for variety between repeats */
  pitch?: number
  /** a multiplier on the sound's own loudness */
  gain?: number
}

/** frequent, cheap sounds that are the first to go when the budget is full */
const LIGHT: ReadonlySet<SoundName> = new Set<SoundName>([
  'click', 'type', 'tick', 'blip', 'toolDone', 'warp', 'grab', 'thud', 'scribble', 'note',
])
export const VOICE_CAP = 40
export const LIGHT_CAP = 22

/** MIDI note → Hz */
export const hz = (note: number): number => 440 * 2 ** ((note - 69) / 12)
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)

/* ── the kit: tiny helpers every recipe is written in ───────────────────── */

interface Kit {
  tool?: string
  ctx: AudioContext
  /** this voice's input: panned, then split into the dry bus and the reverb */
  out: AudioNode
  /** the reverb send alone, for sounds that want extra space */
  wet: AudioNode
  noise: AudioBuffer
  /** the voice's pitch multiplier */
  p: number
}

const FLOOR = 0.0001

/** an attack/decay envelope on a fresh gain node feeding `dest` */
function envelope(k: Kit, at: number, peak: number, attack: number, dur: number,
  dest: AudioNode = k.out): GainNode {
  const g = k.ctx.createGain()
  g.gain.setValueAtTime(FLOOR, at)
  g.gain.linearRampToValueAtTime(Math.max(peak, FLOOR), at + Math.max(attack, 0.001))
  g.gain.exponentialRampToValueAtTime(FLOOR, at + Math.max(dur, attack + 0.002))
  g.connect(dest)
  return g
}

interface ToneSpec {
  type?: OscillatorType
  f: number
  /** glide target, reached at the end of `glide` (default: the whole note) */
  to?: number
  glide?: number
  at: number
  dur: number
  peak: number
  attack?: number
  detune?: number
  /** a filter between the oscillator and the envelope */
  filter?: FilterSpec
  dest?: AudioNode
  /** vibrato: rate in Hz and depth in Hz */
  vib?: [number, number]
}

interface FilterSpec {
  type: BiquadFilterType
  f: number
  to?: number
  q?: number
}

function filterNode(k: Kit, spec: FilterSpec, at: number, dur: number): BiquadFilterNode {
  const f = k.ctx.createBiquadFilter()
  f.type = spec.type
  f.frequency.setValueAtTime(spec.f * k.p, at)
  if (spec.to) f.frequency.exponentialRampToValueAtTime(Math.max(spec.to * k.p, 20), at + dur)
  if (spec.q !== undefined) f.Q.setValueAtTime(spec.q, at)
  return f
}

function tone(k: Kit, s: ToneSpec): void {
  const o = k.ctx.createOscillator()
  o.type = s.type ?? 'sine'
  const f0 = Math.max(s.f * k.p, 10)
  o.frequency.setValueAtTime(f0, s.at)
  if (s.to) o.frequency.exponentialRampToValueAtTime(Math.max(s.to * k.p, 10), s.at + (s.glide ?? s.dur))
  if (s.detune) o.detune.setValueAtTime(s.detune, s.at)
  if (s.vib) {
    const lfo = k.ctx.createOscillator()
    const depth = k.ctx.createGain()
    lfo.frequency.setValueAtTime(s.vib[0], s.at)
    depth.gain.setValueAtTime(s.vib[1] * k.p, s.at)
    lfo.connect(depth); depth.connect(o.frequency)
    lfo.start(s.at); lfo.stop(s.at + s.dur + 0.05)
  }
  const env = envelope(k, s.at, s.peak, s.attack ?? 0.005, s.dur, s.dest)
  if (s.filter) {
    const f = filterNode(k, s.filter, s.at, s.dur)
    o.connect(f); f.connect(env)
  } else o.connect(env)
  o.start(s.at); o.stop(s.at + s.dur + 0.05)
}

interface HissSpec {
  at: number
  dur: number
  peak: number
  attack?: number
  filter: FilterSpec
  dest?: AudioNode
  /** amplitude modulation (Hz) — rumble, crunch, purr */
  am?: number
}

function hiss(k: Kit, s: HissSpec): void {
  const src = k.ctx.createBufferSource()
  src.buffer = k.noise
  src.loop = true
  const env = envelope(k, s.at, s.peak, s.attack ?? 0.003, s.dur, s.dest)
  const f = filterNode(k, s.filter, s.at, s.dur)
  src.connect(f)
  if (s.am) {
    const trem = k.ctx.createGain()
    const lfo = k.ctx.createOscillator()
    const depth = k.ctx.createGain()
    trem.gain.setValueAtTime(0.5, s.at)
    lfo.frequency.setValueAtTime(s.am, s.at)
    depth.gain.setValueAtTime(0.5, s.at)
    lfo.connect(depth); depth.connect(trem.gain)
    lfo.start(s.at); lfo.stop(s.at + s.dur + 0.05)
    f.connect(trem); trem.connect(env)
  } else f.connect(env)
  src.start(s.at, rand(0, 1.5)); src.stop(s.at + s.dur + 0.05)
}

// Original 4.3.2 synthesis helpers for selected game-like event phrases.
function bell(k: Kit, f: number, at: number, dur: number, peak: number,
  ratio = 3.5, index = 4, dest: AudioNode = k.out): void {
  const car = k.ctx.createOscillator()
  const mod = k.ctx.createOscillator()
  const depth = k.ctx.createGain()
  const fc = f * k.p
  car.frequency.setValueAtTime(fc, at)
  mod.frequency.setValueAtTime(fc * ratio, at)
  depth.gain.setValueAtTime(fc * index, at)
  depth.gain.exponentialRampToValueAtTime(Math.max(fc * 0.05, 1), at + dur)
  mod.connect(depth); depth.connect(car.frequency)
  car.connect(envelope(k, at, peak, 0.002, dur, dest))
  car.start(at); mod.start(at); car.stop(at + dur + 0.05); mod.stop(at + dur + 0.05)
}

function brass(k: Kit, f: number, at: number, dur: number, peak: number, bright = 3200): void {
  for (const d of [-9, 0, 8]) {
    tone(k, {
      type: 'sawtooth', f, at, dur, peak: peak / 3, attack: 0.03, detune: d,
      filter: { type: 'lowpass', f: 380, to: bright, q: 1.2 },
    })
  }
}

function drum(k: Kit, f: number, at: number, dur: number, peak: number): void {
  tone(k, { f, to: f * 0.55, at, dur, peak, attack: 0.002 })
  hiss(k, { at, dur: 0.05, peak: peak * 0.5, filter: { type: 'lowpass', f: 1400 } })
}

function crash(k: Kit, at: number, dur: number, peak: number): void {
  hiss(k, { at, dur, peak, filter: { type: 'highpass', f: 4200, q: 0.6 } })
  hiss(k, { at, dur: dur * 0.5, peak: peak * 0.6, filter: { type: 'bandpass', f: 8000, q: 0.8 }, dest: k.wet })
}

function whoosh(k: Kit, at: number, dur: number, peak: number, from: number, to: number): void {
  hiss(k, { at, dur, peak, attack: dur * 0.45, filter: { type: 'bandpass', f: from, to, q: 1.4 } })
}

const PENTA = [0, 2, 4, 7, 9]
const pentatonic = (root: number, i: number): number =>
  hz(root + 12 * Math.floor(i / PENTA.length) + PENTA[i % PENTA.length]!)

/** A short material impact: body, inharmonic metal and filtered contact noise.
 * Name hashes pick the material/size; no musical phrases or beeps. */
function strike(k: Kit, t: number, voice: ReturnType<typeof toolVoice>, peak: number): number {
  const metal = voice.family === 'clank', stamp = voice.family === 'stamp'
  const duration = metal ? voice.duration : voice.duration * 0.55
  tone(k, { type: voice.type, f: voice.hz, to: voice.hz * (metal ? 0.92 : 0.42),
    at: t, dur: duration, attack: voice.attack, peak,
    filter: { type: 'lowpass', f: voice.filter } })
  tone(k, { f: voice.hz * voice.resonance * 2 ** (voice.interval / 24), at: t,
    dur: duration * (metal ? 1 : 0.45), attack: 0.001, peak: peak * (metal ? 0.6 : 0.14) })
  hiss(k, { at: t, dur: stamp ? 0.025 : 0.055, peak: peak * (stamp ? 1.2 : 0.5),
    filter: { type: metal ? 'bandpass' : 'lowpass', f: voice.filter, q: metal ? 4 : 0.7 } })
  if (voice.family === 'clunk') tone(k, { f: voice.hz * 0.6, to: voice.hz * 0.3,
    at: t + 0.035, dur: 0.07, attack: 0.002, peak: peak * 0.45 })
  return duration + 0.08
}

export const SOUND_NAMES = ["zap","ice","thaw","stop","halt","resume","hire","retire","move","reorder","turnStart","turnEnd","tool","toolDone","error","send","notice","stamp","victory","docketMove","drop","question","answer","siren","klaxon","bark","powerFail","tick","clack","click","type","enter","compact","slots","tada","whirr","coins","epicOn","epicOff","whooshIn","whooshOut","boom","thunder","warp","grab","thud","chime","shimmer","wake","sleep","glass","scribble","blip","note","confirm","refused","maxed","ping"] as const satisfies readonly SoundName[]
type Recipe = (k: Kit, t: number) => number
const ALARMS = new Set<SoundName>(['siren', 'klaxon', 'refused', 'error', 'powerFail', 'halt'])
const HEAVY = new Set<SoundName>(['boom', 'thunder', 'victory', 'epicOn', 'epicOff', 'hire', 'retire', 'stamp'])
const RECIPES = Object.fromEntries(SOUND_NAMES.map(name => [name, (k: Kit, t: number) => {
  const voice = toolVoice(name === 'tool' ? k.tool ?? 'tool' : 'factory:' + name)
  const peak = LIGHT.has(name) ? 0.055 : HEAVY.has(name) ? 0.32 : 0.17
  let duration = strike(k, t, voice, peak)
  // Safety alarms retain their explicit warning role as mechanical buzzers.
  if (ALARMS.has(name)) {
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.15
      tone(k, { type: 'sawtooth', f: 94, to: 71, at, dur: 0.10, peak: 0.15,
        filter: { type: 'lowpass', f: 950 } })
      hiss(k, { at, dur: 0.06, peak: 0.08, filter: { type: 'bandpass', f: 1400, q: 2 } })
    }
    duration = Math.max(duration, 0.48)
  } else if (HEAVY.has(name)) {
    strike(k, t + 0.075, { ...voice, hz: voice.hz * 0.55, family: 'thunk' }, peak * 0.7)
    duration += 0.075
  }
  return duration
}])) as Record<SoundName, Recipe>

// User 2026-10-17 21:25Z: keep these original 4.3.2 event phrases beside
// factory ambience and hashed tool impacts. Existing event routing stays intact.
Object.assign(RECIPES, {
  hire: (k, t) => {
    const notes: [number, number, number][] = [[67, 0, 0.13], [72, 0.13, 0.13], [76, 0.26, 0.13], [79, 0.39, 0.75]]
    for (const [n, at, dur] of notes) brass(k, hz(n), t + at, dur + 0.08, 0.34)
    brass(k, hz(72), t + 0.39, 0.83, 0.18, 2200)
    drum(k, 98, t, 0.5, 0.6)
    drum(k, 73, t + 0.39, 0.8, 0.8)
    crash(k, t + 0.39, 1.6, 0.2)
    return 1.9
  },
  victory: (k, t) => {
    ;[[72, 0], [76, 0.1], [79, 0.2], [84, 0.3]].forEach(([n, at]) => brass(k, hz(n!), t + at!, n === 84 ? 0.8 : 0.12, 0.3))
    crash(k, t + 0.3, 1.2, 0.16)
    drum(k, 110, t + 0.3, 0.5, 0.5)
    return 1.3
  },
  turnEnd: (k, t) => {
    bell(k, 1318.5, t, 1.1, 0.14)
    bell(k, 1975.5, t + 0.09, 1.0, 0.1)
    return 1.2
  },
  answer: (k, t) => {
    for (let i = 0; i < 11; i++) {
      tone(k, { type: 'triangle', f: pentatonic(67, i), at: t + i * 0.032, dur: 0.5, peak: 0.1, attack: 0.002 })
    }
    return 0.9
  },
  coins: (k, t) => {
    whoosh(k, t, 0.16, 0.2, 2000, 500)
    bell(k, 2637, t + 0.12, 0.7, 0.14, 1.99, 2.5)
    for (let i = 0; i < 6; i++) bell(k, rand(3200, 5200), t + 0.2 + rand(0, 0.35), 0.18, 0.05, 1.41, 2)
    return 0.9
  },
} satisfies Partial<Record<SoundName, Recipe>>)

/* ── the generated reverb and the noise ─────────────────────────────────── */

function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

/** a stereo impulse response made of exponentially decaying noise */
function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay
  }
  return buffer
}

/* ── the synth ──────────────────────────────────────────────────────────── */

export type AudioContextCtor = new () => AudioContext

export class EpicSynth {
  readonly ctx: AudioContext
  private bus: GainNode
  private wet: GainNode
  private noise: AudioBuffer
  private voices = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private closed = false
  private ambience: ActivityAudio
  private master: GainNode
  private muted: boolean

  constructor(Ctor: AudioContextCtor, opts: { muted?: boolean } = {}) {
    const ctx = new Ctor()
    this.ctx = ctx
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -14
    limiter.knee.value = 8
    limiter.ratio.value = 12
    limiter.attack.value = 0.002
    limiter.release.value = 0.2
    const master = ctx.createGain()
    this.master = master
    this.muted = opts.muted === true
    master.gain.value = this.muted ? 0 : 0.85
    limiter.connect(master)
    master.connect(ctx.destination)
    this.bus = ctx.createGain()
    this.bus.connect(limiter)
    const verb = ctx.createConvolver()
    verb.buffer = impulse(ctx, 2.6, 2.4)
    this.wet = ctx.createGain()
    this.wet.gain.value = 0.32
    this.wet.connect(verb)
    verb.connect(limiter)
    this.noise = whiteNoise(ctx, 2)
    this.ambience = new ActivityAudio(ctx, this.bus, this.noise)
  }

  get active(): number { return this.voices }

  /** One final gain after both dry and reverb paths, including ambience.
   * Keep scheduling voices while muted: activity and heat are unchanged. */
  setMuted(muted: boolean): void {
    if (this.closed || muted === this.muted) return
    this.muted = muted
    const p = this.master.gain, at = this.ctx.currentTime
    if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(at)
    else { p.cancelScheduledValues(at); p.setValueAtTime(p.value, at) }
    p.linearRampToValueAtTime(muted ? 0 : 0.85, at + 0.3)
  }

  activity(counts: ActivityCounts): void { if (!this.closed) this.ambience.update(counts) }

  /** Play one sound now. Returns false when the budget dropped it. */
  play(name: SoundName, opts: PlayOptions = {}): boolean {
    if (this.closed) return false
    const recipe = RECIPES[name]
    if (!recipe) return false
    if (this.voices >= VOICE_CAP || (LIGHT.has(name) && this.voices >= LIGHT_CAP)) return false
    const ctx = this.ctx
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const input = ctx.createGain()
    input.gain.value = Math.max(0, Math.min(2, opts.gain ?? 1))
    let out: AudioNode = input
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner()
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0))
      input.connect(pan)
      out = pan
    }
    out.connect(this.bus)
    const send = ctx.createGain()
    send.gain.value = 0.55
    out.connect(send)
    send.connect(this.wet)
    const kit: Kit = { ctx, out: input, wet: this.wet, noise: this.noise, tool: opts.tool,
      p: opts.pitch ?? (name === 'tool' ? 1 : rand(0.95, 1.05)) }
    let seconds = 0.5
    try { seconds = recipe(kit, ctx.currentTime + 0.01) } catch { /* a node the platform lacks: stay silent */ }
    this.voices++
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.voices = Math.max(0, this.voices - 1)
      try { input.disconnect(); out.disconnect(); send.disconnect() } catch { /* already gone */ }
    }, (seconds + 0.1) * 1000)
    this.timers.add(timer)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.voices = 0
    const close = () => { try { void this.ctx.close().catch(() => {}) } catch { /* already closed */ } }
    const fade = this.ambience.stop()
    if (fade) setTimeout(close, fade)
    else close()
  }
}
