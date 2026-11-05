import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TreeNode, TreePayload } from '../src/types'
import { ACTIVITY_LAYERS, activityScale, activitySources, countActivity, emptyActivity } from '../src/epic/activity'
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

test('only mid-turn agents feed their actual activity layer', () => {
  const sources = activitySources(tree(node('think', 'thinking'), node('write', 'writing'),
    node('args', 'tool_writing'), node('run', 'tool'), node('mcp', 'thinking', { mcp_readiness_waiting: true }),
    node('compact', 'thinking', { phase: 'compacting' }), node('unknown', 'provider-starting'),
    node('idle', 'thinking', { busy: false, last_status: 'working' }),
    node('frozen', 'thinking', { frozen: {} }), node('halted', 'thinking', { halt: { phase: 'halted' } }),
    node('retired', 'thinking', { state: 'archived' }),
    node('project', 'thinking', { kind: 'project', children: [node('child', 'thinking')] })))
  assert.deepEqual(countActivity(sources), { thinking: 2, writing: 1, toolWriting: 1, tool: 1, waiting: 1, compacting: 1 })
  assert.equal(sources.some(s => s.id === 'unknown' && s.layer === null), true, 'unclassified work remains available to heat')
  assert.equal(activitySources({ ...tree(node('a', 'thinking')), killswitch: {} } as TreePayload).length, 0)
})

test('every layer rises audibly with its count, stays finite and is capped', () => {
  assert.equal(activityScale(1), 0.25)
  assert.equal(activityScale(15), 1)
  assert.equal(activityScale(100_000), 1)
  assert.equal(activityScale(8) > activityScale(1) * 3, true)
  for (const n of [0, -1, NaN, Infinity]) assert.equal(activityScale(n), 0)
})

test('epic mode has no sustained activity drone: the synth takes no activity counts and starts nothing on its own', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const base = fakeAudio(), synth = new EpicSynth(base.Ctor)
  assert.equal(typeof (synth as unknown as { activity?: unknown }).activity, 'undefined', 'no activity-driven ambience entry point')
  assert.equal(base.log.started, 0, 'a fresh synth starts no looping source')
  assert.equal(synth.play('click'), true)
  assert.equal(base.log.started > 0, true, 'discrete event audio remains audible')
  synth.close()
  t.mock.timers.tick(100)
  assert.equal(base.log.closed, 1, 'the context closes at once; there is no ambience fade to wait for')
})

test('director seeds existing work immediately and follows state changes, disconnect and org removal', () => {
  const base = fakeAudio(), readings: ReturnType<typeof emptyActivity>[] = []
  const original = SoundHeatmap.prototype.update, originalClear = SoundHeatmap.prototype.clear
  SoundHeatmap.prototype.update = function (sources) { readings.push(countActivity(sources)); original.call(this, sources) }
  // org removal / socket loss clears the heat field directly (no update call): that is an empty reading too
  SoundHeatmap.prototype.clear = function () { readings.push(emptyActivity()); originalClear.call(this) }
  publishEpicTree(tree(node('a', 'tool_writing')))
  const show = startEpic({ audio: base.Ctor })
  try {
    assert.equal(readings.at(-1)!.toolWriting, 1)
    taps.epic?.tree('test', tree(node('a', 'tool')))
    assert.equal(readings.at(-1)!.toolWriting, 0)
    assert.equal(readings.at(-1)!.tool, 1)
    taps.epic?.frame('test', { type: 'epic_link', up: false })
    assert.deepEqual(readings.at(-1), emptyActivity())
    taps.epic?.tree('test', tree(node('a', 'writing')))
    assert.equal(readings.at(-1)!.writing, 1)
    clearEpicTree()
    assert.deepEqual(readings.at(-1), emptyActivity())
  } finally { show.stop(); clearEpicTree(); SoundHeatmap.prototype.update = original; SoundHeatmap.prototype.clear = originalClear }
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
  assert.equal(ACTIVITY_LAYERS.length, 6)
})

test('event sounds remain; activity never starts any looping source', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const base = fakeAudio(), synth = new EpicSynth(base.Ctor)
  assert.equal(base.log.started, 0)
  const started = base.log.started
  assert.equal(synth.play('click'), true)
  assert.equal(base.log.started > started, true, 'discrete event audio remains audible')
  synth.close()
  t.mock.timers.tick(100)
  assert.equal(base.log.closed, 1)
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
