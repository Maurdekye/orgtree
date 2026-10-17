import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { EpicSynth, hz } from '../src/epic/audio'
import type { SoundName } from '../src/epic/audio'
import { fakeAudio } from './epicmode-fakes'

// Audible pitch schedules from the original 4.3.2 recipes (d6e8540), with
// random=0.5 and pitch=1. These distinguish the original phrases from impacts.
const brass = (notes: number[]) => notes.flatMap(n => [hz(n), hz(n), hz(n)])
const profiles: { name: SoundName; frequencies: number[]; seconds: number }[] = [
  { name: 'hire', frequencies: [...brass([67, 72, 76, 79, 72]), 98, 73], seconds: 1.9 },
  { name: 'victory', frequencies: [...brass([72, 76, 79, 84]), 110], seconds: 1.3 },
  { name: 'turnEnd', frequencies: [1318.5, 1318.5 * 3.5, 1975.5, 1975.5 * 3.5], seconds: 1.2 },
  { name: 'answer', frequencies: [67, 69, 71, 74, 76, 79, 81, 83, 86, 88, 91].map(hz), seconds: .9 },
  { name: 'coins', frequencies: [2637, 2637 * 1.99, ...Array.from({ length: 6 }, () => [4200, 4200 * 1.41]).flat()], seconds: .9 },
]

for (const profile of profiles) test(`4.3.x ${profile.name} keeps its musical phrase and voice lifetime`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(Math, 'random', () => .5)
  const audio = fakeAudio(), frequencies: number[] = []
  class RecordingAudio extends audio.Ctor {
    createOscillator() {
      const o = super.createOscillator()
      o.frequency.setValueAtTime = (value: number) => { frequencies.push(value); return o.frequency }
      return o
    }
  }
  const synth = new EpicSynth(RecordingAudio)
  frequencies.length = 0
  try {
    assert.equal(synth.play(profile.name, { pitch: 1 }), true)
    assert.deepEqual(frequencies.map(n => Math.round(n * 1000)), profile.frequencies.map(n => Math.round(n * 1000)))
    // MockTimers retains fractional delays: (1.3 + .1) * 1000 is slightly
    // above 1400ms. Cross that scheduled boundary without rounding it down.
    const lifetime = Math.ceil((profile.seconds + .1) * 1000)
    t.mock.timers.tick(lifetime - 1)
    assert.equal(synth.active, 1, 'the original phrase owns a voice until its tail ends')
    t.mock.timers.tick(1)
    assert.equal(synth.active, 0, 'the voice releases at the original recipe duration')
  } finally { synth.close() }
})
