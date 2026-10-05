import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'

const root = 'apps/desktop/renderer/src/'
const read = name => readFileSync(root + name, 'utf8')
function calls(source, names) {
  const found = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' && names.includes(node.callee.name)) found.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'comments') continue
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }))
  return found
}

test('app consumers have no provider/account/login/settings timer or polling hook', () => {
  for (const name of ['canvas/accounts.tsx', 'canvas/OrgCanvas.tsx', 'shell/defaults.tsx', 'canvas/openrouter.tsx']) {
    const source = read(name)
    assert.deepEqual(calls(source, ['setInterval', 'usePolled', 'usePolledStatus']), [], name)
  }
  const source = read('App.tsx')
  const timers = calls(source, ['setInterval'])
  assert.deepEqual(timers.map(n => source.slice(n.arguments[1].start, n.arguments[1].end)),
    ['TREE_POLL_MS', '10000'], 'only legacy tree transport and the visible age clock remain')
  // These org-scoped panels belong to B4c, whose landing removes their own polls.
  const panelReads = new Set(['getInbox', 'getAudiences', 'getEvents'])
  for (const node of calls(source, ['usePolled', 'usePolledStatus'])) {
    const callback = source.slice(node.arguments[0].start, node.arguments[0].end)
    assert([...panelReads].some(name => callback.includes(name + '(')), callback)
  }
})

test('compatibility polling is explicitly gated by unsupported app feed', () => {
  const feed = read('appfeed.ts')
  assert.equal(calls(feed, ['setInterval']).length, 1)
  assert.match(feed, /if \(feed\.status !== 'unsupported'\) return\s+void refresh\(\)\s+const timer = setInterval/)
  const orgs = read('orgstatus.ts')
  assert.equal(calls(orgs, ['setInterval']).length, 1)
  assert.match(orgs, /if \(!active \|\| !legacy\) return\s+const t = setInterval/)
  const notices = read('notifications.ts')
  assert.equal(calls(notices, ['setInterval']).length, 1)
  assert.match(notices, /feedRef\.current\.status === 'unsupported' && !bridge\.syncNotifications\s+\? setInterval/)
  const native = readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(native, /if \(appFeed\.status === 'unsupported'\) \{\s+const owner = windows\.notificationOwner[\s\S]*?type: 'notification-poll'/)
})
