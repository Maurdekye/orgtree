// NO PARTIAL STREAMED OUTPUT (USER 2026-11-04 ma9e5fa2baad4, m1acf87406e09): with streamer mode on, a tool input still being
// written is never shown (its description, else a placeholder) and responses/thinking show one complete line at a time.
import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { StreamedMd, StreamedThought, ToolChip } from '../src/canvas/desk'
import { wholeLines } from '../src/streamedoutput'
import { startStreamerMode } from '../src/streamer'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES, preferencesPatch } from '../../main/policy'

const native = window as unknown as { orgtreeDesktop?: unknown }
function installBridge(t: TestContext) {
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES }
  const listeners = new Set<(e: { type: string; data: unknown }) => void>()
  const broadcast = () => { for (const fn of [...listeners]) fn({ type: 'preferences', data: saved }) }
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    setPreferences: async (patch: Partial<NativePreferences>) => { saved = { ...saved, ...preferencesPatch(patch) }; broadcast(); return saved },
    onEvent: (fn: (e: { type: string; data: unknown }) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  t.after(() => { native.orgtreeDesktop = previous })
  return { set: (patch: Partial<NativePreferences>) => { saved = { ...saved, ...patch }; broadcast() } }
}
const KEY = 'sk-ant-api03-AbCdeF0123456789xyz'

test('wholeLines keeps only text through the last newline', () => {
  assert.equal(wholeLines('one\ntwo'), 'one\n')
  assert.equal(wholeLines('one\ntwo\n'), 'one\ntwo\n')
  assert.equal(wholeLines('sk-ant-api03-AbC'), '')
  assert.equal(wholeLines(''), '')
})

test('a writing tool call shows its description or a placeholder, never partial input; complete input and OFF are unchanged', async t => {
  useFakeClock()
  const bridge = installBridge(t)
  const stop = startStreamerMode()
  const start = new Date(Date.now()).toISOString()
  const bash = { id: 'b', name: 'Bash', writing_started_at: start, arg: `curl -H ${KEY.slice(0, 20)}`, preview_input: { command: `curl -H ${KEY.slice(0, 20)}` } }
  const view = await mountView(<ToolChip t={bash} slug="org" nid="worker" />, el => el.textContent ?? '')
  t.after(async () => { stop(); await view.unmount(); realClock() })
  await inAct(async () => { await flush(6) })
  // OFF: unchanged (the partial command is shown)
  assert.match(view.el.textContent ?? '', /curl -H sk-ant-api03-AbCde/)
  // ON, toggled mid-stream: the partial command disappears, a neutral placeholder shows
  await inAct(async () => { bridge.set({ streamerMode: true }); await flush(8) })
  assert.doesNotMatch(view.el.textContent ?? '', /curl|sk-ant/, 'no partial command: ' + view.el.textContent)
  assert.match(view.el.querySelector('.targ')?.textContent ?? '', /writing command…/)
  await inAct(() => view.el.querySelector<HTMLElement>('.tline')!.click()); await flush()
  assert.equal(view.el.querySelector('.toolinput'), null, 'the streamed JSON is not shown either')
  // a description written: it is shown, the command still is not
  await view.render(<ToolChip t={{ ...bash, arg: 'Say hello', preview_input: { command: `echo ${KEY.slice(0, 12)}`, description: 'Say hello' } }} slug="org" nid="worker" />)
  assert.match(view.el.querySelector('.targ')?.textContent ?? '', /Say hello/)
  assert.doesNotMatch(view.el.textContent ?? '', /echo|sk-ant/)
  // another tool kind with no description
  await view.render(<ToolChip t={{ id: 'w', name: 'Write', writing_started_at: start, arg: 'C:\\Users\\me\\secret.txt', file_paths: [{ path: 'C:\\Users\\me\\secret.txt', link: false }], preview_input: { file_path: 'C:\\Users\\me\\sec' } }} slug="org" nid="worker" />)
  assert.match(view.el.querySelector('.targ')?.textContent ?? '', /writing input…/)
  assert.doesNotMatch(view.el.textContent ?? '', /secret|Users/)
  // input complete (no longer writing): rendered normally
  await view.render(<ToolChip t={{ id: 'b', name: 'Bash', arg: 'echo hi', started_at: start }} slug="org" nid="worker" />)
  assert.match(view.el.querySelector('.targ')?.textContent ?? '', /echo hi/)
  // toggled OFF mid-stream: shown again
  await view.render(<ToolChip t={bash} slug="org" nid="worker" />)
  await inAct(async () => { bridge.set({ streamerMode: false }); await flush(8) })
  assert.match(view.el.textContent ?? '', /curl -H sk-ant-api03-AbCde/)
})

test('responses and thinking show one complete line at a time while streamer mode is on; half a key is never visible', async t => {
  const bridge = installBridge(t)
  const stop = startStreamerMode()
  const md = (text: string) => ({ __html: `<p>${text.replace(/\n/g, '<br>')}</p>` })
  const view = await mountView(<StreamedMd className="md draft" streaming text={`first line\nsecond ${KEY.slice(0, 16)}`} html={md} />, el => el.textContent ?? '')
  t.after(async () => { stop(); await view.unmount() })
  await inAct(async () => { await flush(6) })
  assert.match(view.el.textContent ?? '', /second sk-ant/, 'OFF: continuous, unchanged')
  await inAct(async () => { bridge.set({ streamerMode: true }); await flush(8) })
  assert.equal((view.el.textContent ?? '').includes('second'), false, 'the line in progress is hidden')
  assert.match(view.el.textContent ?? '', /first line/, 'the complete line shows')
  await view.render(<StreamedMd className="md draft" streaming text={`first line\nsecond ${KEY}\nthird`} html={md} />)
  assert.match(view.el.textContent ?? '', new RegExp('second ' + KEY), 'a line shows whole (the boundary masks it) once its newline arrives')
  assert.equal((view.el.textContent ?? '').includes('third'), false)
  // no newline yet: nothing
  await view.render(<StreamedMd className="md draft" streaming text="sk-ant-api03-AbC" html={md} />)
  assert.equal(view.el.textContent, '')
  // a settled (non-streaming) row is whole
  await view.render(<StreamedMd className="md" streaming={false} text="done sk-ant" html={md} />)
  assert.match(view.el.textContent ?? '', /done/)
  // thinking
  await view.render(<StreamedThought text={`think one\nthinking half ${KEY.slice(0, 10)}`} />)
  assert.match(view.el.textContent ?? '', /think one/)
  assert.equal((view.el.textContent ?? '').includes('half'), false)
  await view.render(<StreamedThought text="only a partial line" />)
  assert.match(view.el.textContent ?? '', /thinking…/)
  assert.equal((view.el.textContent ?? '').includes('partial'), false)
  // toggled off mid-stream: the continuous text returns
  await inAct(async () => { bridge.set({ streamerMode: false }); await flush(8) })
  assert.match(view.el.textContent ?? '', /only a partial line/)
})
