import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './harness'
import { ToolChip } from '../src/canvas/desk'

test('tool file links show only the filename, expose the full path on hover, and replace a duplicate truncated argument', async t => {
  const path = 'C:\\Users\\ncola_k8bx\\AppData\\Roaming\\Orgtree v2\\data\\scratch\\orgtree\\agent-tooltip-luna\\CLAUDE.md'
  const view = await mountView(<ToolChip t={{ id: 'read-1', name: 'Read', arg: path.slice(0, 90),
    file_paths: [{ path, link: true }, { path: 'C:\\workspace\\docs\\SKILL.md', link: true }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  const line = view.el.querySelector('.tline')!
  const links = Array.from(line.querySelectorAll<HTMLAnchorElement>('a[data-local-path]'))
  assert.equal(links.length, 2, 'each explicit path remains an app local-file link')
  assert.equal(links[0].getAttribute('data-local-path'), path)
  assert.equal(links[0].classList.contains('local-file'), true)
  assert.equal(links[0].textContent, 'CLAUDE.md', 'the link label has no leading separator')
  assert.equal(links[0].title, `Show in folder — ${path}`)
  assert.equal(links[1].textContent, 'SKILL.md', 'the SKILL.md link label has no leading separator')
  assert.equal(links[1].title, 'Show in folder — C:\\workspace\\docs\\SKILL.md')
  assert.equal(line.querySelector('.targ') === null, true, 'the path is not repeated in the truncated argument')
  assert.ok(line.textContent?.indexOf('Read')! < line.textContent?.indexOf('CLAUDE.md')!,
    'the link follows the tool call label and argument')
  assert.equal(links[0].closest('.tline'), line, 'the path stays on the tool-call line')
})

test('Skill and edit tool paths keep the separator outside each filename link', async t => {
  const skillPath = 'C:\\workspace\\skills\\review\\SKILL.md'
  const editPath = 'C:\\workspace\\src\\settings.json'
  const view = await mountView(<>
    <ToolChip t={{ id: 'skill-1', name: 'Skill', arg: 'review', file_paths: [{ path: skillPath, link: true }] }} slug="org" nid="agent" />
    <ToolChip t={{ id: 'edit-1', name: 'Edit', arg: editPath, file_paths: [{ path: editPath, link: true }] }} slug="org" nid="agent" />
  </>, el => el)
  t.after(() => view.unmount())
  const lines = Array.from(view.el.querySelectorAll('.tline'))
  assert.equal(lines.length, 2)
  const skillLink = lines[0].querySelector<HTMLAnchorElement>('a[data-local-path]')!
  const editLink = lines[1].querySelector<HTMLAnchorElement>('a[data-local-path]')!
  assert.equal(skillLink.textContent, 'SKILL.md')
  assert.equal(editLink.textContent, 'settings.json')
  assert.match(lines[0].textContent ?? '', /Skill review\s+SKILL\.md/)
  assert.match(lines[1].textContent ?? '', /Edit\s+settings\.json/)
})

test('relative file paths without an event working directory stay plain text', async t => {
  const view = await mountView(<ToolChip t={{ id: 'read-2', name: 'Read',
    file_paths: [{ path: 'notes/todo.md', link: false }] }} slug="org" nid="agent" />, el => el)
  t.after(() => view.unmount())
  assert.equal(view.el.querySelector('a[data-local-path]') === null, true)
  assert.match(view.el.querySelector('.tline')?.textContent ?? '', /notes\/todo\.md/)
})
