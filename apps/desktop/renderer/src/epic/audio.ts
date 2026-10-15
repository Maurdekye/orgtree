/* EPIC Mode — the sound half.

   EVERY SOUND IS SYNTHESIZED HERE, AT PLAY TIME, from oscillators, filtered
   noise and envelopes (Web Audio). The repository is public, so there is no
   recorded, sampled or third-party audio anywhere in EPIC Mode: the noise is
   Math.random, the reverb's impulse response is generated decaying noise, and
   the melodies are short original figures.

   One AudioContext per window, created only when EPIC Mode turns on and
   closed when it turns off. Everything runs through one bus: a dry path and a
   generated-reverb send meet in a compressor that works as the limiter, so a
   busy organization becomes a wall of sound rather than clipping.

   ⚠ A CACOPHONY HAS A BUDGET. Each play is a voice that lives until its
   envelope ends; past VOICE_CAP the cheap, frequent sounds (clicks, typing,
   ticks) are dropped first and only the loud events still get through, so a
   flood of events cannot pile thousands of live nodes onto the audio thread. */

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
  | 'combo' | 'note' | 'confirm' | 'refused' | 'maxed' | 'ping'
  // urgent mail's alarm, one cycle of it (the director repeats it)
  | 'klaxon'

export interface PlayOptions {
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

/** a two-operator FM bell: struck metal, glass, chimes */
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

/** a brass-like voice: three detuned saws through an opening low-pass */
function brass(k: Kit, f: number, at: number, dur: number, peak: number, bright = 3200): void {
  for (const d of [-9, 0, 8]) {
    tone(k, {
      type: 'sawtooth', f, at, dur, peak: peak / 3, attack: 0.03, detune: d,
      filter: { type: 'lowpass', f: 380, to: bright, q: 1.2 },
    })
  }
}

/** inharmonic partials: gongs, clangs, struck plates */
function partials(k: Kit, f: number, ratios: number[], at: number, dur: number,
  peak: number, type: OscillatorType = 'sine'): void {
  ratios.forEach((r, i) => tone(k, {
    type, f: f * r, at, dur: dur / (1 + i * 0.25), peak: peak / (1 + i * 0.6), attack: 0.002,
  }))
}

/** a timpani or kick: a falling sine plus a short filtered noise smack */
function drum(k: Kit, f: number, at: number, dur: number, peak: number): void {
  tone(k, { f, to: f * 0.55, at, dur, peak, attack: 0.002 })
  hiss(k, { at, dur: 0.05, peak: peak * 0.5, filter: { type: 'lowpass', f: 1400 } })
}

/** a crash cymbal: long bright noise */
function crash(k: Kit, at: number, dur: number, peak: number): void {
  hiss(k, { at, dur, peak, filter: { type: 'highpass', f: 4200, q: 0.6 } })
  hiss(k, { at, dur: dur * 0.5, peak: peak * 0.6, filter: { type: 'bandpass', f: 8000, q: 0.8 }, dest: k.wet })
}

/** a whoosh: band-passed noise sweeping between two frequencies */
function whoosh(k: Kit, at: number, dur: number, peak: number, from: number, to: number): void {
  hiss(k, { at, dur, peak, attack: dur * 0.45, filter: { type: 'bandpass', f: from, to, q: 1.4 } })
}

/** a pentatonic run, for harps, slot reels and arpeggios */
const PENTA = [0, 2, 4, 7, 9]
const pentatonic = (root: number, i: number): number =>
  hz(root + 12 * Math.floor(i / PENTA.length) + PENTA[i % PENTA.length]!)

/* ── the recipes ─────────────────────────────────────────────────────────
   Each schedules its sound at `t` and returns how long it lasts (seconds),
   which is how long the voice counts against the budget. */

type Recipe = (k: Kit, t: number) => number

const RECIPES: Record<SoundName, Recipe> = {
  // a message spark: an electric arc snapping down, with crackle
  zap: (k, t) => {
    tone(k, { type: 'sawtooth', f: 3400, to: 150, at: t, dur: 0.17, peak: 0.42,
      filter: { type: 'bandpass', f: 3000, to: 380, q: 6 } })
    tone(k, { type: 'square', f: 120, at: t, dur: 0.14, peak: 0.08 })
    for (let i = 0; i < 5; i++) {
      hiss(k, { at: t + rand(0, 0.16), dur: 0.012, peak: 0.35, filter: { type: 'highpass', f: 2600 } })
    }
    return 0.25
  },
  // freezing: an ice crack, a crystalline cluster and a deep forming whump
  ice: (k, t) => {
    hiss(k, { at: t, dur: 0.05, peak: 0.6, filter: { type: 'highpass', f: 4200 } })
    tone(k, { type: 'triangle', f: 700, to: 5200, at: t, dur: 0.28, peak: 0.12 })
    const cluster = [1568, 2349, 3136, 3951, 4699, 6272]
    cluster.forEach((f, i) => tone(k, {
      f: f * (1 + rand(-0.006, 0.006)), at: t + 0.03 + i * 0.012, dur: 2.2 - i * 0.25,
      peak: 0.11, attack: 0.002, dest: i % 2 ? k.wet : k.out,
    }))
    bell(k, 2637, t + 0.05, 1.8, 0.12, 2.76, 2, k.wet)
    tone(k, { f: 150, to: 52, at: t, dur: 0.4, peak: 0.55 })
    return 2.3
  },
  // unfreezing: rising glassy arpeggio and a melting sweep
  thaw: (k, t) => {
    ;[84, 88, 91, 96, 100].forEach((n, i) => bell(k, hz(n), t + i * 0.055, 0.7, 0.1, 2, 1.5))
    whoosh(k, t, 0.6, 0.2, 600, 7000)
    return 1
  },
  // an interrupt: brake screech into a stop-sign impact
  stop: (k, t) => {
    tone(k, { type: 'sawtooth', f: 2300, at: t, dur: 0.17, peak: 0.16, vib: [34, 140],
      filter: { type: 'bandpass', f: 2500, q: 5 } })
    const hit = t + 0.15
    tone(k, { f: 118, to: 36, at: hit, dur: 0.45, peak: 0.95, attack: 0.002 })
    hiss(k, { at: hit, dur: 0.14, peak: 0.55, filter: { type: 'lowpass', f: 1500 } })
    partials(k, 233, [1, 2.32, 3.86, 5.41, 6.97, 8.93], hit, 1.1, 0.24, 'triangle')
    partials(k, 311, [1, 2.7, 4.1], hit, 0.6, 0.08, 'square')
    return 1.3
  },
  // a halt: klaxon over a boom
  halt: (k, t) => {
    RECIPES.boom(k, t)
    for (let i = 0; i < 4; i++) {
      tone(k, { type: 'square', f: i % 2 ? 440 : 587, at: t + i * 0.24, dur: 0.22, peak: 0.16,
        attack: 0.01, filter: { type: 'lowpass', f: 2600 } })
    }
    return 1.6
  },
  // resuming from a halt: power coming back up, with a bright chord
  resume: (k, t) => {
    tone(k, { type: 'sawtooth', f: 60, to: 480, at: t, dur: 0.55, peak: 0.25, attack: 0.3,
      filter: { type: 'lowpass', f: 200, to: 4000 } })
    ;[72, 76, 79, 84].forEach(n => tone(k, { type: 'triangle', f: hz(n), at: t + 0.5, dur: 0.9, peak: 0.08 }))
    return 1.5
  },
  // a hire: brass fanfare, timpani and a cymbal crash
  hire: (k, t) => {
    const notes: [number, number, number][] = [[67, 0, 0.13], [72, 0.13, 0.13], [76, 0.26, 0.13], [79, 0.39, 0.75]]
    for (const [n, at, dur] of notes) brass(k, hz(n), t + at, dur + 0.08, 0.34)
    brass(k, hz(72), t + 0.39, 0.83, 0.18, 2200)
    drum(k, 98, t, 0.5, 0.6)
    drum(k, 73, t + 0.39, 0.8, 0.8)
    crash(k, t + 0.39, 1.6, 0.2)
    return 1.9
  },
  // a retirement: a gong, and something rising away
  retire: (k, t) => {
    partials(k, 82, [1, 1.48, 2.06, 2.83, 3.92, 5.18], t, 3.2, 0.32)
    bell(k, 164, t, 2.8, 0.1, 1.41, 3, k.wet)
    whoosh(k, t + 0.3, 1.4, 0.18, 300, 4800)
    return 3.3
  },
  // a move: a teleport bwoop with a whoosh
  move: (k, t) => {
    tone(k, { f: 260, to: 1400, glide: 0.2, at: t, dur: 0.22, peak: 0.25 })
    tone(k, { f: 1400, to: 520, at: t + 0.2, dur: 0.22, peak: 0.2 })
    whoosh(k, t, 0.45, 0.25, 400, 3600)
    return 0.6
  },
  // a reorder among siblings: two quick slides
  reorder: (k, t) => {
    whoosh(k, t, 0.18, 0.18, 900, 2400)
    tone(k, { type: 'triangle', f: 660, to: 990, at: t + 0.1, dur: 0.12, peak: 0.12 })
    return 0.3
  },
  // a turn starting: an engine revving up
  turnStart: (k, t) => {
    tone(k, { type: 'sawtooth', f: 70, to: 430, at: t, dur: 0.5, peak: 0.24, attack: 0.08,
      filter: { type: 'lowpass', f: 260, to: 3200, q: 3 } })
    tone(k, { f: 55, to: 110, at: t, dur: 0.5, peak: 0.25, attack: 0.05 })
    return 0.6
  },
  // a turn ending: a bright two-bell chime
  turnEnd: (k, t) => {
    bell(k, 1318.5, t, 1.1, 0.14)
    bell(k, 1975.5, t + 0.09, 1.0, 0.1)
    return 1.2
  },
  // a tool call: mechanical ka-chunk with a laser pew
  tool: (k, t) => {
    hiss(k, { at: t, dur: 0.035, peak: 0.4, filter: { type: 'bandpass', f: 1800, q: 2 } })
    tone(k, { f: 190, to: 60, at: t, dur: 0.07, peak: 0.45 })
    tone(k, { type: 'square', f: 1500, to: 320, at: t + 0.03, dur: 0.11, peak: 0.07 })
    return 0.16
  },
  toolDone: (k, t) => {
    tone(k, { f: 1046, to: 1568, at: t, dur: 0.07, peak: 0.12 })
    return 0.09
  },
  // something failed: a beating buzzer and breaking glass
  error: (k, t) => {
    const shaper = k.ctx.createWaveShaper()
    const curve = new Float32Array(256)
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 4) }
    shaper.curve = curve
    shaper.connect(k.out)
    tone(k, { type: 'sawtooth', f: 98, at: t, dur: 0.36, peak: 0.3, dest: shaper })
    tone(k, { type: 'sawtooth', f: 104, at: t, dur: 0.36, peak: 0.3, dest: shaper })
    RECIPES.glass(k, t + 0.05)
    return 0.6
  },
  // the user sent something: a rocket launch
  send: (k, t) => {
    hiss(k, { at: t, dur: 0.75, peak: 0.32, attack: 0.25, filter: { type: 'bandpass', f: 220, to: 4200, q: 1.2 } })
    tone(k, { f: 180, to: 1700, at: t, dur: 0.6, peak: 0.12, attack: 0.15 })
    for (let i = 0; i < 4; i++) bell(k, hz(rand(88, 100)), t + 0.35 + i * 0.07, 0.4, 0.04, 2, 1.5, k.wet)
    return 0.9
  },
  // a notice: a soft double boop
  notice: (k, t) => {
    tone(k, { f: 660, at: t, dur: 0.1, peak: 0.16 })
    tone(k, { f: 880, at: t + 0.1, dur: 0.14, peak: 0.16 })
    return 0.26
  },
  // a docket item appearing: a rubber stamp slammed down
  stamp: (k, t) => {
    hiss(k, { at: t, dur: 0.07, peak: 0.5, filter: { type: 'lowpass', f: 900 } })
    tone(k, { f: 170, to: 62, at: t, dur: 0.16, peak: 0.6 })
    hiss(k, { at: t + 0.02, dur: 0.18, peak: 0.07, filter: { type: 'highpass', f: 3200 } })
    return 0.25
  },
  // a docket item done: a short victory fanfare
  victory: (k, t) => {
    ;[[72, 0], [76, 0.1], [79, 0.2], [84, 0.3]].forEach(([n, at]) => brass(k, hz(n!), t + at!, n === 84 ? 0.8 : 0.12, 0.3))
    crash(k, t + 0.3, 1.2, 0.16)
    drum(k, 110, t + 0.3, 0.5, 0.5)
    return 1.3
  },
  // a docket status change: a quick two-note slide
  docketMove: (k, t) => {
    tone(k, { type: 'triangle', f: 523, at: t, dur: 0.1, peak: 0.16 })
    tone(k, { type: 'triangle', f: 784, at: t + 0.09, dur: 0.16, peak: 0.16 })
    return 0.28
  },
  // something dropped or deflating
  drop: (k, t) => {
    tone(k, { type: 'sawtooth', f: 420, to: 70, at: t, dur: 0.8, peak: 0.2, vib: [7, 22],
      filter: { type: 'lowpass', f: 1800, to: 300 } })
    return 0.85
  },
  // a question: three dramatic low brass hits over a timpani roll
  question: (k, t) => {
    brass(k, hz(45), t, 0.2, 0.45, 1600)
    brass(k, hz(45), t + 0.24, 0.2, 0.45, 1600)
    brass(k, hz(49), t + 0.5, 1.3, 0.55, 2000)
    brass(k, hz(57), t + 0.5, 1.3, 0.25, 2400)
    for (let i = 0; i < 12; i++) drum(k, 82, t + 0.5 + i * 0.06, 0.12, 0.18 + i * 0.02)
    return 1.9
  },
  // an answer: a harp glissando upward
  answer: (k, t) => {
    for (let i = 0; i < 11; i++) {
      tone(k, { type: 'triangle', f: pentatonic(67, i), at: t + i * 0.032, dur: 0.5, peak: 0.1, attack: 0.002 })
    }
    return 0.9
  },
  // attention: a siren whoop, twice
  siren: (k, t) => {
    for (let i = 0; i < 2; i++) {
      tone(k, { f: 520, to: 1450, at: t + i * 0.42, dur: 0.4, peak: 0.2, attack: 0.04 })
    }
    return 0.9
  },
  // URGENT MAIL: one 0.8 s cycle of a klaxon, high then low a minor third
  // apart. Each note is a buzzing square ground against a sawtooth a semitone
  // below it, under a fast warble: obnoxious by its character, not its
  // volume, which stays at the siren's (user 2026-10-15: "not excessively
  // loud but very attention demanding and obnoxious")
  klaxon: (k, t) => {
    const harsh: FilterSpec = { type: 'lowpass', f: 3400, q: 0.8 }
    for (const [at, f] of [[t, 784], [t + 0.4, 659]] as const) {
      tone(k, { type: 'square', f, at, dur: 0.36, peak: 0.08, attack: 0.012, vib: [11, 16], filter: harsh })
      tone(k, { type: 'sawtooth', f: f * 0.944, at, dur: 0.36, peak: 0.06, attack: 0.012, vib: [11, 16], filter: harsh })
    }
    return 0.8
  },
  // a watchdog firing: woof woof
  bark: (k, t) => {
    for (const at of [t, t + 0.22]) {
      const bus = k.ctx.createGain()
      bus.gain.setValueAtTime(1, at)
      const f1 = k.ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.setValueAtTime(720, at); f1.Q.setValueAtTime(4, at)
      const f2 = k.ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.setValueAtTime(1250, at); f2.Q.setValueAtTime(5, at)
      bus.connect(f1); bus.connect(f2); f1.connect(k.out); f2.connect(k.out)
      tone(k, { type: 'sawtooth', f: 430, to: 170, at, dur: 0.16, peak: 0.9, attack: 0.008, dest: bus })
      hiss(k, { at, dur: 0.12, peak: 0.35, filter: { type: 'bandpass', f: 900, q: 1 }, dest: bus })
    }
    return 0.45
  },
  // a usage limit: the power failing
  powerFail: (k, t) => {
    tone(k, { type: 'sawtooth', f: 520, to: 32, at: t, dur: 1.15, peak: 0.28,
      filter: { type: 'lowpass', f: 4200, to: 160 } })
    for (let i = 0; i < 7; i++) {
      hiss(k, { at: t + rand(0, 0.9), dur: 0.02, peak: 0.3, filter: { type: 'highpass', f: 3000 } })
    }
    tone(k, { type: 'square', f: 50, at: t, dur: 1.1, peak: 0.05 })
    return 1.25
  },
  tick: (k, t) => {
    tone(k, { type: 'square', f: 3000, at: t, dur: 0.012, peak: 0.05 })
    return 0.02
  },
  // a setting flipped: a heavy switch clack with a sparkle
  clack: (k, t) => {
    hiss(k, { at: t, dur: 0.018, peak: 0.45, filter: { type: 'bandpass', f: 3400, q: 3 } })
    tone(k, { f: 1250, to: 600, at: t, dur: 0.04, peak: 0.2 })
    for (let i = 0; i < 3; i++) bell(k, hz(rand(96, 108)), t + 0.03 + i * 0.04, 0.3, 0.035, 2, 1.2, k.wet)
    return 0.3
  },
  // a click on any control: a punchy thock with a tiny pew
  click: (k, t) => {
    tone(k, { f: 320, to: 120, at: t, dur: 0.05, peak: 0.32 })
    hiss(k, { at: t, dur: 0.012, peak: 0.25, filter: { type: 'bandpass', f: 2600, q: 2 } })
    tone(k, { type: 'square', f: 1900, to: 620, at: t + 0.01, dur: 0.07, peak: 0.04 })
    return 0.09
  },
  // typing: typewriter key strikes
  type: (k, t) => {
    hiss(k, { at: t, dur: 0.014, peak: 0.28, filter: { type: 'highpass', f: 1600 } })
    tone(k, { type: 'square', f: 4000, at: t, dur: 0.006, peak: 0.04 })
    return 0.03
  },
  // Enter: the carriage-return bell
  enter: (k, t) => {
    hiss(k, { at: t, dur: 0.12, peak: 0.12, filter: { type: 'bandpass', f: 1200, to: 2600, q: 2 } })
    bell(k, 2093, t + 0.1, 0.9, 0.16, 3.01, 2.5)
    return 1
  },
  // a compaction: a crusher grinding down
  compact: (k, t) => {
    hiss(k, { at: t, dur: 0.75, peak: 0.42, attack: 0.05, am: 26, filter: { type: 'lowpass', f: 900, to: 260 } })
    tone(k, { type: 'sawtooth', f: 55, to: 38, at: t, dur: 0.75, peak: 0.18, filter: { type: 'lowpass', f: 300 } })
    drum(k, 90, t + 0.72, 0.35, 0.6)
    return 1.1
  },
  // an account or model switch: slot-machine reels and a ding
  slots: (k, t) => {
    for (let i = 0; i < 9; i++) {
      tone(k, { type: 'square', f: pentatonic(72, Math.floor(rand(0, 10))), at: t + i * 0.045, dur: 0.04,
        peak: 0.07, filter: { type: 'lowpass', f: 3000 } })
    }
    bell(k, 1760, t + 0.42, 0.8, 0.13)
    return 1.25
  },
  // a document presented: ta-da
  tada: (k, t) => {
    brass(k, hz(67), t, 0.12, 0.3)
    brass(k, hz(72), t + 0.14, 0.75, 0.34)
    brass(k, hz(76), t + 0.14, 0.75, 0.2)
    RECIPES.shimmer(k, t + 0.14)
    return 1
  },
  // a file transfer: a conveyor whirr
  whirr: (k, t) => {
    tone(k, { type: 'sawtooth', f: 210, at: t, dur: 0.55, peak: 0.12, vib: [16, 30],
      filter: { type: 'bandpass', f: 700, to: 2200, q: 2 } })
    whoosh(k, t, 0.55, 0.1, 500, 2500)
    return 0.6
  },
  // credits: a cash drawer and coins
  coins: (k, t) => {
    whoosh(k, t, 0.16, 0.2, 2000, 500)
    bell(k, 2637, t + 0.12, 0.7, 0.14, 1.99, 2.5)
    for (let i = 0; i < 6; i++) bell(k, rand(3200, 5200), t + 0.2 + rand(0, 0.35), 0.18, 0.05, 1.41, 2)
    return 0.9
  },
  // EPIC Mode itself turning on: a rising whoosh, an orchestral hit, thunder
  epicOn: (k, t) => {
    whoosh(k, t, 0.5, 0.35, 150, 6000)
    const hit = t + 0.45
    for (const n of [36, 43, 48, 52, 55, 60, 64, 67, 72]) brass(k, hz(n), hit, 1.7, 0.2, 6000)
    drum(k, 65, hit, 1.2, 1)
    crash(k, hit, 2.6, 0.3)
    RECIPES.thunder(k, hit + 0.1)
    return 3.4
  },
  // and off: a long power-down whine
  epicOff: (k, t) => {
    tone(k, { type: 'sawtooth', f: 640, to: 28, at: t, dur: 1.3, peak: 0.24,
      filter: { type: 'lowpass', f: 5000, to: 120 } })
    tone(k, { f: 90, to: 30, at: t + 1.1, dur: 0.3, peak: 0.5 })
    return 1.5
  },
  whooshIn: (k, t) => { whoosh(k, t, 0.3, 0.3, 350, 3200); return 0.32 },
  whooshOut: (k, t) => { whoosh(k, t, 0.3, 0.3, 3200, 350); return 0.32 },
  // an explosion: low boom, sub drop and crackle
  boom: (k, t) => {
    hiss(k, { at: t, dur: 1.4, peak: 0.85, attack: 0.004, filter: { type: 'lowpass', f: 900, to: 90 } })
    tone(k, { f: 70, to: 24, at: t, dur: 1.2, peak: 0.9, attack: 0.003 })
    for (let i = 0; i < 9; i++) {
      hiss(k, { at: t + rand(0.05, 1), dur: 0.02, peak: 0.22, filter: { type: 'bandpass', f: rand(800, 3000), q: 2 } })
    }
    return 1.5
  },
  // thunder: a crack and a long rolling rumble
  thunder: (k, t) => {
    hiss(k, { at: t, dur: 0.12, peak: 0.6, filter: { type: 'highpass', f: 1800 } })
    hiss(k, { at: t + 0.05, dur: 2.6, peak: 0.6, attack: 0.2, am: 5, filter: { type: 'lowpass', f: 380, to: 60 } })
    return 2.8
  },
  // a canvas zoom: a short warp
  warp: (k, t) => {
    tone(k, { type: 'triangle', f: 300, to: 900, at: t, dur: 0.12, peak: 0.06 })
    return 0.14
  },
  // picking something up and putting it down
  grab: (k, t) => { tone(k, { f: 220, to: 330, at: t, dur: 0.06, peak: 0.2 }); return 0.08 },
  thud: (k, t) => { drum(k, 120, t, 0.18, 0.5); return 0.2 },
  // a generic success: a three-note chime
  chime: (k, t) => {
    ;[79, 84, 88].forEach((n, i) => bell(k, hz(n), t + i * 0.07, 0.8, 0.09, 2, 1.8))
    return 1
  },
  // sparkle dust
  shimmer: (k, t) => {
    for (let i = 0; i < 8; i++) bell(k, hz(rand(91, 110)), t + i * 0.03, 0.35, 0.04, 2, 1.2, k.wet)
    return 0.6
  },
  // an agent waking (idle → working, or a CLI starting)
  wake: (k, t) => {
    tone(k, { type: 'triangle', f: 392, to: 784, at: t, dur: 0.18, peak: 0.14 })
    bell(k, 1568, t + 0.15, 0.5, 0.06)
    return 0.6
  },
  // an agent going quiet
  sleep: (k, t) => {
    tone(k, { type: 'triangle', f: 784, to: 330, at: t, dur: 0.35, peak: 0.12 })
    return 0.4
  },
  // breaking glass: many brief high partials and noise shards
  glass: (k, t) => {
    for (let i = 0; i < 14; i++) {
      const at = t + rand(0, 0.25)
      tone(k, { f: rand(2800, 8200), at, dur: rand(0.04, 0.22), peak: 0.05, attack: 0.001 })
    }
    for (let i = 0; i < 5; i++) {
      hiss(k, { at: t + rand(0, 0.2), dur: 0.03, peak: 0.25, filter: { type: 'highpass', f: 5000 } })
    }
    return 0.5
  },
  // writing: a quick scribble
  scribble: (k, t) => {
    hiss(k, { at: t, dur: 0.16, peak: 0.12, am: 38, filter: { type: 'bandpass', f: 3000, q: 1.5 } })
    return 0.18
  },
  blip: (k, t) => { tone(k, { type: 'square', f: 1760, at: t, dur: 0.03, peak: 0.04 }); return 0.04 },

  /* ── the final version's additions ───────────────────────────────────── */

  // a combo reaching a new rank (the Wonder Full take's milestone fanfare):
  // a brass run up the scale into a held chord, timpani and a crash. The
  // director raises its pitch rank by rank.
  combo: (k, t) => {
    ;[60, 64, 67, 72, 76, 79].forEach((n, i) => brass(k, hz(n), t + i * 0.055, 0.1, 0.22, 4200))
    const hit = t + 0.34
    for (const n of [72, 76, 79, 84]) brass(k, hz(n), hit, 0.9, 0.2, 5200)
    drum(k, 82, hit, 0.7, 0.8)
    crash(k, hit, 1.6, 0.22)
    RECIPES.shimmer(k, hit + 0.1)
    return 1.9
  },
  // one plucked note of an agent's streamed text (the Argon take's
  // pentatonic arpeggio): the director picks the pitch, step by step
  note: (k, t) => {
    bell(k, hz(72), t, 0.42, 0.06, 2, 1.1, k.wet)
    tone(k, { type: 'triangle', f: hz(72), at: t, dur: 0.22, peak: 0.05 })
    return 0.45
  },
  // a confirming click (save, apply, create, OK …): a two-coin ding
  confirm: (k, t) => {
    bell(k, 1568, t, 0.5, 0.12, 2, 2.2)
    bell(k, 2349, t + 0.08, 0.75, 0.12, 2, 2.2)
    for (let i = 0; i < 3; i++) bell(k, rand(3500, 5200), t + 0.12 + i * 0.05, 0.2, 0.03, 1.41, 2, k.wet)
    return 0.9
  },
  // a request the engine refused (the Astra take's FAULT): a denied double
  // buzz over a dull thud
  refused: (k, t) => {
    tone(k, { type: 'square', f: 233, at: t, dur: 0.13, peak: 0.16, filter: { type: 'lowpass', f: 2400 } })
    tone(k, { type: 'square', f: 175, to: 110, at: t + 0.14, dur: 0.3, peak: 0.16, filter: { type: 'lowpass', f: 2000 } })
    drum(k, 86, t, 0.3, 0.5)
    return 0.5
  },
  // a usage reading reaching 100% — a meter maxing out, not a power failure:
  // a reading is not exhaustion (the Astra take's rule; user 2026-10-14)
  maxed: (k, t) => {
    tone(k, { type: 'sawtooth', f: 220, to: 1320, at: t, dur: 0.45, peak: 0.14, attack: 0.05,
      filter: { type: 'lowpass', f: 600, to: 5200, q: 2 } })
    ;[84, 88, 91].forEach((n, i) => tone(k, { type: 'square', f: hz(n), at: t + 0.42 + i * 0.08, dur: 0.07, peak: 0.07,
      filter: { type: 'lowpass', f: 3600 } }))
    bell(k, hz(96), t + 0.66, 0.9, 0.12, 2, 2)
    return 1.5
  },
  // a sonar ping (the Astra and Argon takes' watchdog radar)
  ping: (k, t) => {
    tone(k, { f: 988, at: t, dur: 0.14, peak: 0.12, dest: k.wet })
    tone(k, { f: 1568, at: t + 0.13, dur: 0.7, peak: 0.12 })
    tone(k, { f: 1568, at: t + 0.13, dur: 0.9, peak: 0.08, dest: k.wet })
    return 1
  },
}

export const SOUND_NAMES = Object.keys(RECIPES) as SoundName[]

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

  constructor(Ctor: AudioContextCtor) {
    const ctx = new Ctor()
    this.ctx = ctx
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -14
    limiter.knee.value = 8
    limiter.ratio.value = 12
    limiter.attack.value = 0.002
    limiter.release.value = 0.2
    const master = ctx.createGain()
    master.gain.value = 0.85
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
  }

  get active(): number { return this.voices }

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
    const kit: Kit = { ctx, out: input, wet: this.wet, noise: this.noise, p: opts.pitch ?? rand(0.95, 1.05) }
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
    try { void this.ctx.close().catch(() => {}) } catch { /* already closed */ }
  }
}
