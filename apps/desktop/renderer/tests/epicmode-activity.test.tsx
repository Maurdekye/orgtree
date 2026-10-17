import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TreeNode, TreePayload } from '../src/types'
import { ACTIVITY_LAYERS, activityScale, activitySources, countActivity, emptyActivity } from '../src/epic/activity'
import { ACTIVITY_FADE_MS } from '../src/epic/ambience'
import { EpicSynth } from '../src/epic/audio'
import { startEpic } from '../src/epic/director'
import { clearEpicTree, publishEpicTree } from '../src/epic/tap'
import * as taps from '../src/epic/tap'
import { fakeAudio } from './epicmode-fakes'
import { normalizeToolName, toolVoice } from '../src/epic/toolvoice'
import { SoundHeatmap } from '../src/epic/heatmap'

const node = (id: string, phase: string, extra = {}): TreeNode =>
  ({ id, state: 'live', busy: true, activity: { phase }, children: [], ...extra }) as unknown as TreeNode
const tree = (...roots: TreeNode[]): TreePayload => ({ slug: 'test', roots }) as unknown as TreePayload

test('only mid-turn agents feed the shared hum and their actual activity layer', () => {
  const sources = activitySources(tree(node('think', 'thinking'), node('write', 'writing'),
    node('args', 'tool_writing'), node('run', 'tool'), node('mcp', 'thinking', { mcp_readiness_waiting: true }),
    node('compact', 'thinking', { phase: 'compacting' }), node('unknown', 'provider-starting'),
    node('idle', 'thinking', { busy: false, last_status: 'working' }),
    node('frozen', 'thinking', { frozen: {} }), node('halted', 'thinking', { halt: { phase: 'halted' } }),
    node('retired', 'thinking', { state: 'archived' }),
    node('project', 'thinking', { kind: 'project', children: [node('child', 'thinking')] })))
  assert.deepEqual(countActivity(sources), { hum: 8, thinking: 2, writing: 1, toolWriting: 1, tool: 1, waiting: 1, compacting: 1 })
  assert.equal(activitySources({ ...tree(node('a', 'thinking')), killswitch: {} } as TreePayload).length, 0)
})

test('every layer rises audibly with its count, stays finite and is capped', () => {
  assert.equal(activityScale(1), 0.25)
  assert.equal(activityScale(15), 1)
  assert.equal(activityScale(100_000), 1)
  assert.equal(activityScale(8) > activityScale(1) * 3, true)
  for (const n of [0, -1, NaN, Infinity]) assert.equal(activityScale(n), 0)
})

test('one shared voice per layer, crossfades and idle cleanup, including smooth context shutdown', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const base = fakeAudio(), ramps: { value: number; at: number }[] = []
  let stops = 0
  class Audio extends base.Ctor {
    createGain() {
      const g = super.createGain()
      g.gain.linearRampToValueAtTime = (value, at) => { ramps.push({ value, at }); return g.gain }
      return g
    }
    createOscillator() { const o = super.createOscillator(); o.stop = () => { stops++ }; return o }
  }
  const synth = new EpicSynth(Audio), counts = { ...emptyActivity(), hum: 1, thinking: 1 }
  synth.activity(counts)
  const nodes = base.log.nodes
  for (let i = 0; i < 1000; i++) synth.activity(counts)
  assert.equal(base.log.nodes, nodes, 'updates never stack per-agent oscillators')
  const first = ramps.filter(r => r.value > 0).map(r => r.value)
  synth.activity({ ...counts, thinking: 15 })
  assert.equal(ramps.some(r => r.value >= first[1]! * 3.9), true, 'actual audio gain follows agent count')
  synth.activity({ ...emptyActivity(), hum: 1, writing: 1 })
  assert.equal(ramps.at(-2)?.value, 0, 'old activity fades out')
  assert.equal(ramps.at(-1)!.value > 0, true, 'new activity fades in')
  assert.equal(stops, 0, 'a crossfade never cuts a voice off at the transition')
  t.mock.timers.tick(ACTIVITY_FADE_MS + 35)
  assert.equal(stops, 2, 'the old layer releases both its oscillators after fading')
  synth.close()
  assert.equal(base.log.closed, 0, 'context remains open through the final fade')
  assert.equal(ramps.at(-1)!.at, ACTIVITY_FADE_MS / 1000)
  t.mock.timers.tick(ACTIVITY_FADE_MS + 45)
  assert.equal(base.log.closed, 1)
  assert.equal(stops, 6)
  synth.activity(counts)
  assert.equal(base.log.closed, 1, 'closed show cannot restart its layers')
})

test('director seeds existing work immediately and follows state changes, disconnect and org removal', () => {
  const base = fakeAudio(), readings: ReturnType<typeof emptyActivity>[] = []
  const original = EpicSynth.prototype.activity
  EpicSynth.prototype.activity = function (counts) { readings.push({ ...counts }); original.call(this, counts) }
  publishEpicTree(tree(node('a', 'tool_writing')))
  const show = startEpic({ audio: base.Ctor })
  try {
    assert.equal(readings.at(-1)!.toolWriting, 1)
    taps.epic?.tree('test', tree(node('a', 'tool')))
    assert.equal(readings.at(-1)!.toolWriting, 0)
    assert.equal(readings.at(-1)!.tool, 1)
    taps.epic?.frame('test', { type: 'epic_link', up: false })
    assert.equal(readings.at(-1)!.hum, 0)
    taps.epic?.tree('test', tree(node('a', 'writing')))
    assert.equal(readings.at(-1)!.writing, 1)
    clearEpicTree()
    assert.equal(readings.at(-1)!.hum, 0)
  } finally { show.stop(); clearEpicTree(); EpicSynth.prototype.activity = original }
})

test('normalised tool names determine all signature parameters across harness prefixes', () => {
  assert.equal(normalizeToolName(' MCP__Server__Read_File '), 'read_file')
  assert.deepEqual(toolVoice('MCP__server__Read_File'), toolVoice('functions.read_file'))
  assert.deepEqual(toolVoice('tools.READ_FILE'), toolVoice('read_file'))
  const names = ['read_file', 'apply_patch', 'exec_command', 'orgtree_message', 'orgtree_work', 'glob', 'search', 'web_search']
  const voices = names.map(toolVoice)
  assert.equal(new Set(voices.map(v => JSON.stringify(v))).size, names.length)
  for (const v of voices) {
    assert.equal(v.hz >= 72 && v.hz <= 300, true)
    assert.equal(['thunk', 'clunk', 'clank', 'stamp'].includes(v.family), true)
    assert.equal(v.resonance > 1 && v.resonance < 3, true)
    assert.equal(v.duration >= 0.14 && v.duration <= 0.36, true)
    assert.equal(v.attack > 0 && v.attack < v.duration, true)
  }
  assert.equal(ACTIVITY_LAYERS.length, 7)
})

test('tool names reach the synth and only accepted agent sounds inject heat', () => {
  const base = fakeAudio(), spikes: string[] = [], names: (string | undefined)[] = []
  const play = EpicSynth.prototype.play, impulse = SoundHeatmap.prototype.impulse
  let accept = false
  EpicSynth.prototype.play = function (_name, opts) { names.push(opts?.tool); return accept }
  SoundHeatmap.prototype.impulse = id => { spikes.push(id) }
  const show = startEpic({ audio: base.Ctor })
  try {
    show.cue('tool', { node: 'rejected', text: 'mcp__server__read_file' })
    assert.deepEqual(spikes, [])
    accept = true
    show.cue('tool', { node: 'a', text: 'mcp__server__read_file' })
    assert.equal(names.at(-1), 'mcp__server__read_file')
    assert.deepEqual(spikes, ['a'])
    show.cue('click')
    assert.deepEqual(spikes, ['a'], 'a subjectless click has no source agent')
  } finally { show.stop(); EpicSynth.prototype.play = play; SoundHeatmap.prototype.impulse = impulse }
})
