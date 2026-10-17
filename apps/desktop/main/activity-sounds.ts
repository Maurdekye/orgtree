import { isActivitySound, type ActivitySoundFrame, type ActivitySoundKind,
  type ActivitySoundPreferences } from '../../../packages/contracts/activity-sounds'

/** One main-process owner, bounded dedup and playback, no historical inventory. */
export class ActivitySounds {
  private epoch = ''
  private seq = -1
  private seen = new Set<string>()
  private queue: { kind: ActivitySoundKind; preview: boolean; resolve: (ok: boolean) => void }[] = []
  private running = false
  private closed = false
  constructor(private play: (kind: ActivitySoundKind) => Promise<void>,
    private preferences: () => ActivitySoundPreferences,
    private failed: (error: unknown) => void = () => {}) {}

  private enabled(kind: ActivitySoundKind): boolean {
    const prefs = this.preferences()
    return kind === 'response' ? prefs.responseSound : prefs.taskSound
  }
  receive(value: unknown): void {
    if (this.closed || !isActivitySound(value)) return
    const frame: ActivitySoundFrame = value
    if (frame.epoch !== this.epoch) {
      this.epoch = frame.epoch; this.seq = -1; this.seen.clear()
    }
    if (frame.seq <= this.seq) return
    this.seq = frame.seq
    const key = JSON.stringify([frame.kind, frame.org_id, frame.id])
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!)
    if (this.enabled(frame.kind)) void this.enqueue(frame.kind, false)
  }
  preview(kind: unknown): Promise<boolean> {
    if (kind !== 'response' && kind !== 'task') return Promise.reject(new Error('Invalid sound kind'))
    return this.enqueue(kind, true)
  }
  private enqueue(kind: ActivitySoundKind, preview: boolean): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.queue.length >= 64) {
      this.failed(new Error('Activity sound queue is full'))
      return Promise.resolve(false)
    }
    return new Promise(resolve => {
      this.queue.push({ kind, preview, resolve })
      void this.drain()
    })
  }
  private async drain() {
    if (this.running) return
    this.running = true
    try {
      while (!this.closed && this.queue.length) {
        const next = this.queue.shift()!
        if (!next.preview && !this.enabled(next.kind)) { next.resolve(false); continue }
        try { await this.play(next.kind); next.resolve(true) }
        catch (error) { this.failed(error); next.resolve(false) }
      }
    } finally { this.running = false }
  }
  close() {
    this.closed = true
    for (const next of this.queue.splice(0)) next.resolve(false)
  }
}

/** Small synthesized sine tones; no remote asset, platform command or OS toast. */
export const ACTIVITY_TONES = {
  response: [[784, 0.13]],
  task: [[523.25, 0.12], [659.25, 0.12], [784, 0.18]],
} as const
export function activitySoundPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>Orgtree sounds</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">
<script>
const tones = ${JSON.stringify(ACTIVITY_TONES)};
let context;
window.playActivitySound = async kind => {
  if (!Object.hasOwn(tones, kind)) throw Error('Invalid sound kind');
  context ??= new AudioContext();
  await context.resume();
  if (context.state !== 'running') throw Error('Audio output unavailable');
  const start = context.currentTime + 0.02;
  let time = start;
  return new Promise(resolve => {
    const notes = tones[kind];
    notes.forEach(([frequency, duration], index) => {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.10, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.onended = () => {
        oscillator.disconnect(); gain.disconnect();
        if (index === notes.length - 1) { const state = context.state; context.suspend().then(() => resolve({kind, state, notes: notes.length})); }
      };
      oscillator.start(time); oscillator.stop(time + duration + 0.01);
      time += duration + 0.045;
    });
  });
};
</script>`
}
