// Remote organizations (docs/rust-engine/remote-org.md, "What depends on the
// computer"): a window of an organization on a remote engine gets nothing of
// this computer's disk or sign-in windows. The renderer keeps its controls
// from asking; the main process is the authority and refuses on its own.
//
// index.ts cannot be loaded outside Electron, so this reads how each native
// command is registered: every one that opens a folder, opens or reveals a
// file, checks a path or starts a provider sign-in must be registered with
// `handleHere`, which asks `remoteRefusal` before the handler runs.
// Run: node tests/run.mjs tests/remote-org-native-refusal.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('apps/desktop/main/index.ts', 'utf8').replace(/\r\n/g, '\n')
const remotes = fs.readFileSync('apps/desktop/main/remotes.ts', 'utf8')

const HERE = [
  'desktop:open-agent-scratch-folder',
  'desktop:agent-scratch-agents-file-exists',
  'desktop:open-agent-scratch-agents-file',
  'desktop:open-charter-folder',
  'desktop:open-templates-folder',
  'desktop:local-file-status',
  'desktop:open-local-file',
  'desktop:reveal-file',
  'desktop:pick-folder',
  'desktop:provider-login-start',
]

const registered = channel => {
  const found = source.match(new RegExp(`\\b(handle[A-Za-z]*)\\('${channel}'`))
  assert.ok(found, `${channel} is registered`)
  return found[1]
}

test('every native command that uses this computer’s disk or sign-in windows refuses a remote window', () => {
  for (const channel of HERE) assert.equal(registered(channel), 'handleHere', channel)
})

test('handleHere asks before the handler runs, and the answer comes from the window’s own identity', () => {
  assert.match(source, /const handleHere = \(channel: string, handler: \(caller: MainWindowRecord, \.\.\.args: unknown\[\]\) => unknown\) =>\n\s+handle\(channel, \(caller, \.\.\.args\) => remoteRefusal\(caller\) \?\? handler\(caller, \.\.\.args\)\)/)
  // the organization is the caller's registered identity, never an argument the page chose
  assert.match(source, /const remoteRefusal = [^\n]+\n\s+const org = windows\.identity\(caller\.id\)\?\.org\n\s+return org && remoteByAlias\.has\(org\) \? \{ ok: false, error: REMOTE_WINDOW_REFUSAL, remote: true \} : null/)
  // one map, the one the request header is decided from
  assert.equal(source.match(/let remoteByAlias\b/g)?.length, 1)
  assert.match(remotes, /export const REMOTE_WINDOW_REFUSAL = '[^']*remote engine[^']*not on this one\.'/)
})

test('commands that belong to this app on this computer stay available to a remote window', () => {
  // the engine log folder, preferences and updates are this computer's whatever organization the window shows
  for (const channel of ['desktop:open-logs-folder', 'desktop:update-status', 'desktop:provider-login-status'])
    assert.notEqual(registered(channel), 'handleHere', channel)
})
