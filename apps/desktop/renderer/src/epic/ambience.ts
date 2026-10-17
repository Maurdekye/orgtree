import { ACTIVITY_LAYERS, activityScale, type ActivityCounts, type ActivityLayer } from './activity'

export const ACTIVITY_FADE_MS = 300
// Peak amplitude of each shared layer, below the discrete event recipes.
const TIMBRES: Record<ActivityLayer, { type: OscillatorType; hz: number; filter: number; pulse: number; peak: number }> = {
  hum: { type: 'sine', hz: 55, filter: 180, pulse: 0.28, peak: 0.035 },
  thinking: { type: 'sine', hz: 220, filter: 1200, pulse: 1.4, peak: 0.020 },
  writing: { type: 'triangle', hz: 330, filter: 1300, pulse: 5.2, peak: 0.018 },
  toolWriting: { type: 'square', hz: 165, filter: 700, pulse: 11, peak: 0.022 },
  tool: { type: 'triangle', hz: 110, filter: 520, pulse: 7.5, peak: 0.020 },
  waiting: { type: 'sine', hz: 440, filter: 900, pulse: 0.65, peak: 0.014 },
  compacting: { type: 'sawtooth', hz: 73.4, filter: 260, pulse: 2.3, peak: 0.018 },
}
interface Layer {
  gain: GainNode
  sources: OscillatorNode[]
  nodes: AudioNode[]
  target: number
  timer?: ReturnType<typeof setTimeout>
}

/** Seven shared voices at most. Native oscillators loop without JS ticks. */
export class ActivityAudio {
  private layers = new Map<ActivityLayer, Layer>()
  private ended = false
  constructor(private ctx: AudioContext, private out: AudioNode) {}

  update(counts: ActivityCounts): void {
    if (this.ended) return
    let sounding = false
    for (const name of ACTIVITY_LAYERS) {
      const target = TIMBRES[name].peak * activityScale(counts[name])
      let layer = this.layers.get(name)
      if (!layer && target > 0) { layer = this.create(name); this.layers.set(name, layer) }
      if (!layer || layer.target === target) continue
      if (layer.timer) { clearTimeout(layer.timer); layer.timer = undefined }
      this.ramp(layer, target)
      if (target === 0) layer.timer = setTimeout(() => this.release(name, layer!), ACTIVITY_FADE_MS + 30)
      else sounding = true
    }
    if (sounding && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
  }

  /** Fade before the owning context closes. Returns the remaining fade time. */
  stop(): number {
    if (this.ended) return 0
    this.ended = true
    for (const [name, layer] of this.layers) {
      if (layer.timer) clearTimeout(layer.timer)
      this.ramp(layer, 0)
      layer.timer = setTimeout(() => this.release(name, layer), ACTIVITY_FADE_MS + 30)
    }
    return this.layers.size ? ACTIVITY_FADE_MS + 40 : 0
  }

  private ramp(layer: Layer, target: number): void {
    const at = this.ctx.currentTime
    const p = layer.gain.gain
    if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(at)
    else { p.cancelScheduledValues(at); p.setValueAtTime(p.value, at) }
    p.linearRampToValueAtTime(target, at + ACTIVITY_FADE_MS / 1000)
    layer.target = target
  }

  private create(name: ActivityLayer): Layer {
    const spec = TIMBRES[name], at = this.ctx.currentTime
    const carrier = this.ctx.createOscillator(), lfo = this.ctx.createOscillator()
    const filter = this.ctx.createBiquadFilter(), tremolo = this.ctx.createGain()
    const depth = this.ctx.createGain(), gain = this.ctx.createGain()
    carrier.type = spec.type
    carrier.frequency.value = spec.hz
    filter.type = 'lowpass'; filter.frequency.value = spec.filter; filter.Q.value = 0.5
    lfo.frequency.value = spec.pulse
    tremolo.gain.value = 0.75; depth.gain.value = 0.20
    gain.gain.setValueAtTime(0, at)
    lfo.connect(depth); depth.connect(tremolo.gain)
    carrier.connect(filter); filter.connect(tremolo); tremolo.connect(gain); gain.connect(this.out)
    carrier.start(at); lfo.start(at)
    return { gain, sources: [carrier, lfo], nodes: [carrier, lfo, filter, tremolo, depth, gain], target: 0 }
  }

  private release(name: ActivityLayer, layer: Layer): void {
    if (this.layers.get(name) !== layer) return
    this.layers.delete(name)
    for (const source of layer.sources) { try { source.stop() } catch { /* already ended */ } }
    for (const node of layer.nodes) { try { node.disconnect() } catch { /* already detached */ } }
  }
}
