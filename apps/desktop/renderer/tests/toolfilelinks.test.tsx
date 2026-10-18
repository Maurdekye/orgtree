import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { ToolChip } from '../src/canvas/desk'

test('tool file paths are linked after the tool label on the same line', async t => {
  const view = await mountView(<ToolChip t={{ id: 'read-1', name: 'Read', arg: 'Read config',
    file_paths: [{ path: 'C:\\work tree\\config.json', link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  const line = view.el.querySelector('.tline')!
  const link = line.querySelector('a[data-local-path]')
  assert.ok(link, 'the explicit file path is an app local-file link')
  assert.equal(link.getAttribute('data-local-path'), 'C:\\work tree\\config.json')
  assert.equal(link.classList.contains('local-file'), true)
  assert.ok(line.textContent?.indexOf('Read config')! < line.textContent?.indexOf('C:\\work tree\\config.json')!,
    'the link follows the tool call label and argument')
  assert.equal(link.closest('.tline'), line, 'the path stays on the tool-call line')
})

test('relative file paths without an event working directory stay plain text', async t => {
  const view = await mountView(<ToolChip t={{ id: 'read-2', name: 'Read',
    file_paths: [{ path: 'notes/todo.md', link: false }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('a[data-local-path]') === null, true)
  assert.match(view.el.querySelector('.tline')?.textContent ?? '', /notes\/todo\.md/)
})
