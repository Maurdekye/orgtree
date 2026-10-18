import { flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EpicSynth } from '../src/epic/audio'
import { emptyActivity } from '../src/epic/activity'
import { startEpicSync } from '../src/epic/sync'
import { Preferences } from '../../main/preferences'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'
import { fakeAudio } from './epicmode-fakes'
import * as taps from '../src/epic/tap'

test('EPIC mute is a boolean native preference, absent by default and retained on reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epic-mute-pref-')), file = path.join(dir, 'settings.json')
  const prefs = new Preferences(file)
  assert.equal('epicMuted' in prefs.get(), false)
  prefs.set({ epicMode: true, epicMuted: true })
  assert.equal((new Preferences(file).get() as any).epicMuted, true)
  prefs.set({ epicMode: false })
  assert.equal((new Preferences(file).get() as any).epicMuted, true)
  for (const value of [1, 'true', null, {}]) assert.throws(() => preferencesPatch({ epicMuted: value }))
})

test('mute fades the final output, including active layers and event/reverb routes, without stopping visuals', () => {
  const base = fakeAudio(), gains: GainNode[] = [], ramps: { value: number; at: number }[] = []
  class Audio extends base.Ctor {
    createGain() {
      const gain = super.createGain(); gains.push(gain)
      gain.gain.linearRampToValueAtTime = (value, at) => { if (gain === gains[0]) ramps.push({ value, at }); return gain.gain }
      return gain
    }
  }
  const synth = new EpicSynth(Audio, { muted: true })
  try {
    assert.equal(gains[0]!.gain.value, 0, 'a persisted mute is silent before any first greeting or layer')
    synth.activity({ ...emptyActivity(), tool: 2 })
    assert.equal(synth.play('tool', { tool: 'read_file' }), true, 'muted action sounds still drive their visual heat impulses')
    assert.equal(base.log.closed, 0)
    assert.equal(typeof (synth as any).setMuted, 'function')
    synth.setMuted(false)
    assert.equal(ramps.at(-1)!.value, 0.85)
    assert.equal(ramps.at(-1)!.at > synth.ctx.currentTime, true, 'unmute ramps rather than jumps')
    synth.setMuted(true)
    assert.equal(ramps.at(-1)!.value, 0)
    assert.equal(ramps.at(-1)!.at > synth.ctx.currentTime, true)
    const count = ramps.length
    synth.setMuted(true)
    assert.equal(ramps.length, count, 'unchanged preference broadcasts do not restart the fade')
  } finally { synth.close() }
})

test('the existing one-subscription sync applies live tray mute and keeps the same show and taps', async () => {
  const native = window as any, previous = native.orgtreeDesktop, audioBefore = native.AudioContext
  const base = fakeAudio(), masters: GainNode[] = []
  class Audio extends base.Ctor {
    constructor() { super(); this.first = true }
    private first: boolean
    createGain() { const g = super.createGain(); if (this.first) { masters.push(g); this.first = false }; return g }
  }
  let saved: any = { ...DEFAULT_PREFERENCES, epicMode: true, epicMuted: true }
  const listeners = new Set<(event: any) => void>()
  native.orgtreeDesktop = { getPreferences: async () => saved, onEvent: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn) } }
  native.AudioContext = Audio
  const stop = startEpicSync()
  try {
    await flush(20)
    assert.equal(listeners.size, 1)
    assert.equal(masters[0]!.gain.value, 0, 'startup reads mute together with enable')
    const tap = taps.epic, canvases = document.querySelectorAll('.epic-stage').length
    let target = -1
    masters[0]!.gain.linearRampToValueAtTime = (value) => { target = value; return masters[0]!.gain }
    saved = { ...saved, epicMuted: false }
    for (const fn of listeners) fn({ type: 'preferences', data: saved })
    assert.equal(target, 0.85)
    saved = { ...saved, epicMuted: true }
    for (const fn of listeners) fn({ type: 'preferences', data: saved })
    assert.equal(target, 0)
    assert.equal(taps.epic === tap, true)
    assert.equal(document.querySelectorAll('.epic-stage').length, canvases)
    assert.equal(base.log.created, 1, 'mute neither destroys nor recreates the show')
  } finally { stop(); native.orgtreeDesktop = previous; native.AudioContext = audioBefore }
  assert.equal(listeners.size, 0)
})
