import { ACTIVITY_LAYERS, activityScale, type ActivityCounts, type ActivityLayer } from './activity'

export const ACTIVITY_FADE_MS = 300
// Peak amplitude of each shared layer, below the discrete event recipes.
const TIMBRES: Record<ActivityLayer, { type: OscillatorType; hz: number; filter: number; pulse: number; peak: number; grit: number }> = {
  thinking: { type: 'sawtooth', hz: 83, filter: 480, pulse: 19, peak: 0.020, grit: 0.45 }, // geared whirr
  writing: { type: 'triangle', hz: 63, filter: 1100, pulse: 8, peak: 0.018, grit: 0.8 }, // conveyor rollers
  toolWriting: { type: 'square', hz: 97, filter: 1600, pulse: 13, peak: 0.022, grit: 1.1 }, // ratchet
  tool: { type: 'triangle', hz: 38, filter: 700, pulse: 3.5, peak: 0.020, grit: 0.7 }, // piston strokes
  waiting: { type: 'triangle', hz: 51, filter: 220, pulse: 1.2, peak: 0.014, grit: 0.3 }, // idling flywheel
  compacting: { type: 'sawtooth', hz: 69, filter: 900, pulse: 23, peak: 0.018, grit: 1.3 }, // grinding
}
interface Layer {
  gain: GainNode
  sources: (OscillatorNode | AudioBufferSourceNode)[]
  nodes: AudioNode[]
  target: number
  timer?: ReturnType<typeof setTimeout>
}

/** Six shared voices at most. Native oscillators loop without JS ticks. */
export class ActivityAudio {
  private layers = new Map<ActivityLayer, Layer>()
  private ended = false
  constructor(private ctx: AudioContext, private out: AudioNode, private noise: AudioBuffer) {}

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
    const depth = this.ctx.createGain(), gain = this.ctx.createGain(), grit = this.ctx.createGain()
    const friction = this.ctx.createBufferSource()
    friction.buffer = this.noise; friction.loop = true; grit.gain.value = spec.grit
    carrier.type = spec.type
    carrier.frequency.value = spec.hz
    filter.type = 'lowpass'; filter.frequency.value = spec.filter; filter.Q.value = 0.5
    lfo.type = name === 'waiting' ? 'sine' : 'square'
    lfo.frequency.value = spec.pulse
    tremolo.gain.value = 0.55; depth.gain.value = 0.40
    gain.gain.setValueAtTime(0, at)
    lfo.connect(depth); depth.connect(tremolo.gain)
    friction.connect(grit); grit.connect(filter)
    carrier.connect(filter); filter.connect(tremolo); tremolo.connect(gain); gain.connect(this.out)
    carrier.start(at); lfo.start(at); friction.start(at)
    return { gain, sources: [carrier, lfo, friction], nodes: [carrier, lfo, friction, grit, filter, tremolo, depth, gain], target: 0 }
  }

  private release(name: ActivityLayer, layer: Layer): void {
    if (this.layers.get(name) !== layer) return
    this.layers.delete(name)
    for (const source of layer.sources) { try { source.stop() } catch { /* already ended */ } }
    for (const node of layer.nodes) { try { node.disconnect() } catch { /* already detached */ } }
  }
}
