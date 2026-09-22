// The native organization-window foundation: window identity, caller-scoped
// sender resolution, atomic organization routing, targeted-reveal queueing,
// single-owner notification duties, the dirty-creation close/quit gate and
// startup restoration.
//
// Every rule here is driven WITHOUT Electron, the same way popoutRegistry's
// rules are: the registry takes a narrow window-like interface and an injected
// clock, so a race, an expiry and a destroyed window are all ordinary values.
// The negative controls are the point of the file — duplicate-open races,
// cross-window commands and untrusted senders each get a test that asserts the
// refusal, not merely the happy path.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-org-windows-test-'))
const req = createRequire(import.meta.url)
async function load(entry, name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const { orgWindowRegistry, openOrg, resolveNativeSender, planRestore } =
  await load('apps/desktop/main/org-windows.ts', 'org-windows')
const { isOrgSlug } = await load('packages/contracts/desktop-window.ts', 'desktop-window')
const { isAppPath } = await load('packages/contracts/ui-route.ts', 'ui-route')

const ORIGIN = 'http://127.0.0.1:5173'
let nextSender = 100
/** A window as the registry sees it, plus the two fields sender resolution
 *  needs. `url` is the document its main frame is showing. */
const fakeWindow = (url = `${ORIGIN}/`) => {
  const mainFrame = { url }
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed },
    webContents: { id: ++nextSender, mainFrame },
  }
}
const registration = (id, window) => ({ id, senderId: window.webContents.id, window })
const add = (registry, id, kind, org) => {
  const window = fakeWindow()
  registry.register({ ...registration(id, window), kind, ...(org ? { org } : {}) })
  return window
}

// ------------------------------------------------------------------ identity

test('a window carries an explicit identity, and only a bound one names an organization', () => {
  const registry = orgWindowRegistry()
  const home = fakeWindow(), create = fakeWindow(), bound = fakeWindow()
  assert.deepEqual(registry.register({ ...registration('w1', home), kind: 'homepage' }),
    { windowId: 'w1', kind: 'homepage', notificationOwner: true })
  assert.deepEqual(registry.register({ ...registration('w2', create), kind: 'create' }),
    { windowId: 'w2', kind: 'create', notificationOwner: false })
  assert.deepEqual(registry.register({ ...registration('w3', bound), kind: 'org', org: 'acme' }),
    { windowId: 'w3', kind: 'org', org: 'acme', notificationOwner: false })
  // an unbound window may not smuggle an organization in
  assert.throws(() => registry.register({ ...registration('w4', fakeWindow()), kind: 'homepage', org: 'acme' }),
    /Only an org-bound window/)
  assert.throws(() => registry.register({ ...registration('w5', fakeWindow()), kind: 'org', org: 'Not A Slug' }),
    /valid organization/)
  assert.throws(() => registry.register({ ...registration('w1', fakeWindow()), kind: 'homepage' }),
    /already registered/)
})

test('a window registered with someone else\'s sender id is refused outright', () => {
  // Sender resolution matches on this integer and then backstops it with a
  // main-frame identity comparison, so a wrong id cannot OPEN the gate - but
  // it would quietly reduce a two-condition check to one, and a wiring bug
  // that passed the wrong webContents id would never announce itself.
  const registry = orgWindowRegistry()
  const window = fakeWindow()
  assert.throws(() => registry.register({ id: 'w1', senderId: window.webContents.id + 1, window, kind: 'homepage' }),
    /but its webContents is/)
  assert.equal(registry.get('w1'), undefined)
})

test('one organization, one window — a second registration for it is refused', () => {
  const registry = orgWindowRegistry()
  add(registry, 'w1', 'org', 'acme')
  assert.throws(() => registry.register({ ...registration('w2', fakeWindow()), kind: 'org', org: 'acme' }),
    /already open/)
})

test('a destroyed window stops holding its organization and stops being addressable', () => {
  const registry = orgWindowRegistry()
  const window = add(registry, 'w1', 'org', 'acme')
  assert.equal(registry.byOrg('acme').id, 'w1')
  window.destroyed = true
  assert.equal(registry.byOrg('acme'), undefined)
  assert.equal(registry.get('w1'), undefined)
  assert.equal(registry.list().length, 0)
  // and the organization can now be opened again
  assert.equal(registry.requestOrg('acme', null).action, 'open')
})

// ------------------------------------------------------------------- routing

test('a homepage window binds itself to an unopened organization', () => {
  const registry = orgWindowRegistry()
  add(registry, 'home', 'homepage')
  assert.deepEqual(registry.requestOrg('acme', 'home'), { action: 'bound', windowId: 'home', org: 'acme' })
  assert.deepEqual(registry.identity('home'), { windowId: 'home', kind: 'org', org: 'acme', notificationOwner: true })
})

test('an org-bound window NEVER switches organization', () => {
  const registry = orgWindowRegistry()
  add(registry, 'acme-window', 'org', 'acme')
  const decision = registry.requestOrg('beta', 'acme-window')
  assert.equal(decision.action, 'open', 'another organization opens elsewhere')
  assert.deepEqual(registry.identity('acme-window'), { windowId: 'acme-window', kind: 'org', org: 'acme', notificationOwner: true },
    'the calling window is untouched')
})

test('a create window is never rebound by an ordinary open request', () => {
  const registry = orgWindowRegistry()
  add(registry, 'create', 'create')
  assert.equal(registry.requestOrg('acme', 'create').action, 'open')
  assert.deepEqual(registry.identity('create'), { windowId: 'create', kind: 'create', notificationOwner: true })
})

test('an already-open organization focuses its own window and leaves the caller alone', () => {
  const registry = orgWindowRegistry()
  add(registry, 'acme-window', 'org', 'acme')
  add(registry, 'home', 'homepage')
  assert.deepEqual(registry.requestOrg('acme', 'home'), { action: 'focused', windowId: 'acme-window', org: 'acme' })
  assert.deepEqual(registry.identity('home'), { windowId: 'home', kind: 'homepage', notificationOwner: false },
    'the initiating homepage stays a homepage')
})

test('NEGATIVE CONTROL: two homepages racing for one organization produce exactly one bound window', () => {
  const registry = orgWindowRegistry()
  add(registry, 'home-a', 'homepage')
  add(registry, 'home-b', 'homepage')
  const first = registry.requestOrg('acme', 'home-a')
  const second = registry.requestOrg('acme', 'home-b')
  assert.deepEqual(first, { action: 'bound', windowId: 'home-a', org: 'acme' })
  assert.deepEqual(second, { action: 'focused', windowId: 'home-a', org: 'acme' },
    'the loser is sent to the winner, never given its own copy')
  assert.equal(registry.list().filter(entry => entry.org === 'acme').length, 1)
})

test('NEGATIVE CONTROL: two unowned requests racing produce one reservation, not two windows', () => {
  const registry = orgWindowRegistry()
  const first = registry.requestOrg('acme', null)
  const second = registry.requestOrg('acme', null)
  assert.equal(first.action, 'open')
  assert.deepEqual(second, { action: 'pending', org: 'acme' },
    'the second caller is told to do nothing, not to open a duplicate')
  assert.deepEqual(registry.reservedOrgs(), ['acme'])
  registry.adoptReservation(first.ticket, registration('w1', fakeWindow()))
  assert.equal(registry.list().filter(entry => entry.org === 'acme').length, 1)
  assert.deepEqual(registry.reservedOrgs(), [], 'adoption consumes the reservation')
  assert.deepEqual(registry.requestOrg('acme', null), { action: 'focused', windowId: 'w1', org: 'acme' })
})

test('a malformed organization and an unknown caller are refused, never guessed at', () => {
  const registry = orgWindowRegistry()
  assert.deepEqual(registry.requestOrg('Not A Slug', null), { action: 'refused', org: 'Not A Slug', reason: 'invalid-org' })
  assert.deepEqual(registry.requestOrg('', null), { action: 'refused', org: '', reason: 'invalid-org' })
  assert.deepEqual(registry.requestOrg(null, null), { action: 'refused', org: '', reason: 'invalid-org' })
  assert.deepEqual(registry.requestOrg('acme', 'no-such-window'), { action: 'refused', org: 'acme', reason: 'unknown-window' })
})

test('a released reservation frees the organization at once; the time bound is only a backstop', () => {
  let clock = 1_000
  const registry = orgWindowRegistry({ now: () => clock, reservationTtlMs: 5_000 })
  const first = registry.requestOrg('acme', null)
  registry.releaseReservation(first.ticket)
  assert.deepEqual(registry.reservedOrgs(), [])
  assert.equal(registry.requestOrg('acme', null).action, 'open',
    'a failed open is retryable immediately, not after the time bound')

  // and a ticket the host died holding stops blocking on its own
  const leaked = registry.requestOrg('beta', null)
  assert.equal(leaked.action, 'open')
  assert.deepEqual(registry.requestOrg('beta', null), { action: 'pending', org: 'beta' })
  clock += 5_001
  assert.equal(registry.requestOrg('beta', null).action, 'open', 'the leaked claim stopped blocking')
})

test('f1: a slow creation can still adopt its own ticket after the block window lapses', () => {
  // The time bound stops a DEAD host wedging an organization shut. A live
  // host that took longer than that to build a window is not that case, and
  // refusing its adoption used to strand the finished window.
  let clock = 1_000
  const registry = orgWindowRegistry({ now: () => clock, reservationTtlMs: 5_000 })
  const slow = registry.requestOrg('acme', null)
  assert.equal(slow.action, 'open')
  clock += 60_000                                   // creation took a very long time
  assert.deepEqual(registry.reservedOrgs(), [], 'it no longer blocks anybody')
  const identity = registry.adoptReservation(slow.ticket, registration('acme-window', fakeWindow()))
  assert.deepEqual(identity, { windowId: 'acme-window', kind: 'org', org: 'acme', notificationOwner: true })
})

test('f1: a ticket that was already consumed or never existed is refused', () => {
  const registry = orgWindowRegistry()
  const first = registry.requestOrg('acme', null)
  registry.adoptReservation(first.ticket, registration('w1', fakeWindow()))
  assert.throws(() => registry.adoptReservation(first.ticket, registration('w2', fakeWindow())), /unknown/)
  assert.throws(() => registry.adoptReservation('reservation-999', registration('w3', fakeWindow())), /unknown/)
})

// ------------------------------------------------------------------ creation

test('a successful creation binds its own window and nothing else', () => {
  const registry = orgWindowRegistry()
  add(registry, 'create', 'create')
  add(registry, 'home', 'homepage')
  assert.deepEqual(registry.bindCreated('create', 'acme'), { action: 'bound', windowId: 'create', org: 'acme' })
  assert.deepEqual(registry.identity('create'), { windowId: 'create', kind: 'org', org: 'acme', notificationOwner: true })
  assert.deepEqual(registry.identity('home'), { windowId: 'home', kind: 'homepage', notificationOwner: false })
})

test('binding a created organization is refused from anywhere but a creation window', () => {
  const registry = orgWindowRegistry()
  add(registry, 'home', 'homepage')
  add(registry, 'acme-window', 'org', 'acme')
  assert.deepEqual(registry.bindCreated('home', 'beta'), { action: 'refused', org: 'beta', reason: 'not-a-creation-window' })
  assert.deepEqual(registry.bindCreated('acme-window', 'beta'), { action: 'refused', org: 'beta', reason: 'already-bound' })
  assert.deepEqual(registry.bindCreated('ghost', 'beta'), { action: 'refused', org: 'beta', reason: 'unknown-window' })
  assert.deepEqual(registry.identity('home'), { windowId: 'home', kind: 'homepage', notificationOwner: true })
})

test('a creation whose organization is already taken keeps its window and its form', () => {
  const registry = orgWindowRegistry()
  add(registry, 'acme-window', 'org', 'acme')
  add(registry, 'create', 'create')
  registry.setUnsavedCreation('create', true)
  assert.deepEqual(registry.bindCreated('create', 'acme'), { action: 'refused', org: 'acme', reason: 'already-open' })
  assert.deepEqual(registry.identity('create'), { windowId: 'create', kind: 'create', notificationOwner: false })
  assert.equal(registry.beginClose('create'), 'confirm', 'the draft survives the refusal')
})

test('becoming an organization clears the unfinished-form flag', () => {
  const registry = orgWindowRegistry()
  add(registry, 'create', 'create')
  registry.setUnsavedCreation('create', true)
  registry.bindCreated('create', 'acme')
  assert.equal(registry.beginClose('create'), 'close', 'a bound window is no longer a form in progress')
})

// ------------------------------------------- the host completes its own work

const hostFor = (registry, log = []) => ({
  log,
  focus: entry => log.push(`focus:${entry.id}`),
  create: async org => { log.push(`create:${org}`); return registration(`window-for-${org}`, fakeWindow()) },
  discard: created => log.push(`discard:${created.id}`),
  deliverReveals: (entry, reveals) => log.push(`deliver:${entry.id}:${reveals.join(',')}`),
  undeliverable: (org, reveals) => log.push(`undeliverable:${org}:${reveals.join(',')}`),
})

test('openOrg finishes the whole transaction natively; no ticket ever reaches the caller', async () => {
  const registry = orgWindowRegistry()
  const host = hostFor(registry)
  const outcome = await openOrg(registry, 'acme', null, host)
  assert.deepEqual(outcome, { action: 'opened', windowId: 'window-for-acme', org: 'acme' })
  assert.equal('ticket' in outcome, false, 'a reservation ticket is native-internal')
  assert.deepEqual(registry.reservedOrgs(), [])
  assert.deepEqual(await openOrg(registry, 'acme', null, host), { action: 'focused', windowId: 'window-for-acme', org: 'acme' })
  assert.deepEqual(host.log, ['create:acme', 'focus:window-for-acme'])
})

test('a failed open clears its claim immediately and reports what it could not deliver', async () => {
  const registry = orgWindowRegistry()
  const log = []
  const failing = { ...hostFor(registry, log), create: async () => { throw new Error('no window') } }
  registry.queueReveal('acme', 'notice-1')
  await assert.rejects(() => openOrg(registry, 'acme', null, failing), /no window/)
  assert.deepEqual(registry.reservedOrgs(), [], 'the organization is not left claimed')
  assert.deepEqual(log, ['undeliverable:acme:notice-1'], 'the waiting reveal is reported, not dropped')
  // and the next attempt is a fresh open, not a 'pending' that never resolves
  const retry = await openOrg(registry, 'acme', null, hostFor(registry))
  assert.equal(retry.action, 'opened')
})

test('NEGATIVE CONTROL (f1): a window that cannot be adopted is handed back, never stranded', async () => {
  // The window EXISTS by the time adoption can fail. Unregistered it is
  // unusable - every bridge call is refused and it is frameless, so it has no
  // OS chrome either - and the organization would be left unclaimed, so the
  // next request opens a SECOND window for it. That is the exact outcome the
  // reservation mechanism exists to prevent, arriving through the error path.
  const registry = orgWindowRegistry()
  const log = []
  const host = {
    ...hostFor(registry, log),
    // another window takes the organization while this one is being built
    create: async org => {
      log.push(`create:${org}`)
      registry.register({ ...registration('winner', fakeWindow()), kind: 'org', org })
      return registration('loser', fakeWindow())
    },
  }
  const outcome = await openOrg(registry, 'acme', null, host)
  assert.deepEqual(outcome, { action: 'focused', windowId: 'winner', org: 'acme' },
    'the user asked for that organization and it is open: show them the one that won')
  assert.deepEqual(log, ['create:acme', 'discard:loser', 'focus:winner'],
    'and the surplus window is disposed of, not left on screen')
  assert.equal(registry.get('loser'), undefined, 'it was never registered')
  assert.equal(registry.list().filter(entry => entry.org === 'acme').length, 1,
    'exactly one window for the organization, as always')
  assert.deepEqual(registry.reservedOrgs(), [], 'and the claim is gone')
})

test('f1: a reveal waiting on a failed adoption goes to the window that won', async () => {
  const registry = orgWindowRegistry()
  const log = []
  registry.queueReveal('acme', 'notice-1')
  const host = {
    ...hostFor(registry, log),
    create: async org => {
      log.push(`create:${org}`)
      registry.register({ ...registration('winner', fakeWindow()), kind: 'org', org })
      return registration('loser', fakeWindow())
    },
  }
  await openOrg(registry, 'acme', null, host)
  assert.deepEqual(log, ['create:acme', 'discard:loser', 'focus:winner', 'deliver:winner:notice-1'])
  assert.equal(registry.pendingReveals('acme'), 0)
})

test('f1: an adoption that fails with no winner discards the window and reports, then rethrows', async () => {
  const registry = orgWindowRegistry()
  const log = []
  registry.queueReveal('acme', 'notice-2')
  const host = {
    ...hostFor(registry, log),
    // a duplicate window id is a host bug, not a race: nothing holds the org
    create: async () => {
      registry.register({ ...registration('taken-id', fakeWindow()), kind: 'homepage' })
      return registration('taken-id', fakeWindow())
    },
  }
  await assert.rejects(() => openOrg(registry, 'acme', null, host), /already registered/)
  assert.deepEqual(log, ['discard:taken-id', 'undeliverable:acme:notice-2'])
  assert.deepEqual(registry.reservedOrgs(), [], 'the organization is not left claimed')
})

// -------------------------------------------------------- targeted reveals

test('a reveal for an open organization goes straight to that organization window', () => {
  const registry = orgWindowRegistry()
  add(registry, 'acme-window', 'org', 'acme')
  add(registry, 'beta-window', 'org', 'beta')
  assert.equal(registry.queueReveal('acme', 'notice').id, 'acme-window')
  assert.equal(registry.pendingReveals('acme'), 0, 'nothing is queued when it can be delivered now')
})

test('a reveal that arrives before its window is held, not dropped, and lands on adoption', async () => {
  const registry = orgWindowRegistry()
  // the notification click both opens the organization and wants to reveal an
  // item in it: the reveal is ready before the window exists
  assert.equal(registry.queueReveal('acme', 'notice-1'), undefined)
  assert.equal(registry.pendingReveals('acme'), 1)
  const host = hostFor(registry)
  await openOrg(registry, 'acme', null, host)
  assert.deepEqual(host.log, ['create:acme', 'deliver:window-for-acme:notice-1'])
  assert.equal(registry.pendingReveals('acme'), 0)
})

test('a reveal queued during a pending open is delivered by the window already on its way', async () => {
  const registry = orgWindowRegistry()
  const first = registry.requestOrg('acme', null)          // someone is opening it
  registry.queueReveal('acme', 'notice-2')                  // a click arrives mid-open
  assert.deepEqual(registry.requestOrg('acme', null), { action: 'pending', org: 'acme' })
  assert.equal(registry.pendingReveals('acme'), 1, 'still held while the window is on its way')
  registry.adoptReservation(first.ticket, registration('acme-window', fakeWindow()))
  assert.deepEqual(registry.takeReveals('acme'), ['notice-2'])
})

test('a reveal delivered to a homepage that just bound itself is not lost in the transition', async () => {
  const registry = orgWindowRegistry()
  add(registry, 'home', 'homepage')
  registry.queueReveal('acme', 'notice-3')
  const host = hostFor(registry)
  assert.deepEqual(await openOrg(registry, 'acme', 'home', host), { action: 'bound', windowId: 'home', org: 'acme' })
  assert.deepEqual(host.log, ['deliver:home:notice-3'])
})

// ------------------------------------------------------ caller-scoped trust

const invoke = window => ({ sender: { id: window.webContents.id }, senderFrame: window.webContents.mainFrame })

test('sender resolution answers WHICH registered window called', () => {
  const registry = orgWindowRegistry()
  const acme = add(registry, 'acme-window', 'org', 'acme')
  const beta = add(registry, 'beta-window', 'org', 'beta')
  assert.equal(resolveNativeSender(invoke(acme), registry, ORIGIN).id, 'acme-window')
  assert.equal(resolveNativeSender(invoke(beta), registry, ORIGIN).id, 'beta-window',
    'each window resolves to itself and never to the other')
})

test('NEGATIVE CONTROL: every sender that is not a trusted main window is refused', () => {
  const registry = orgWindowRegistry()
  const window = add(registry, 'acme-window', 'org', 'acme')
  const refused = /refused for this document/

  // a webContents that is not a registered main window at all - a popout, the
  // tray popup, an artifact viewer, anything else in the process
  assert.throws(() => resolveNativeSender({ sender: { id: 9999 }, senderFrame: { url: `${ORIGIN}/` } }, registry, ORIGIN), refused)
  // a sub-frame of a real window: same webContents, different frame object
  assert.throws(() => resolveNativeSender({ sender: { id: window.webContents.id }, senderFrame: { url: `${ORIGIN}/` } }, registry, ORIGIN), refused)
  assert.throws(() => resolveNativeSender({ sender: { id: window.webContents.id }, senderFrame: null }, registry, ORIGIN), refused)
  // a real main frame showing a document that is not app UI
  window.webContents.mainFrame.url = 'https://example.com/'
  assert.throws(() => resolveNativeSender(invoke(window), registry, ORIGIN), refused)
  // the engine origin but not an app route
  window.webContents.mainFrame.url = `${ORIGIN}/api/orgs/acme/documents/x/mockup`
  assert.throws(() => resolveNativeSender(invoke(window), registry, ORIGIN), refused)
  // a different engine origin
  window.webContents.mainFrame.url = 'http://127.0.0.1:9999/'
  assert.throws(() => resolveNativeSender(invoke(window), registry, ORIGIN), refused)
  // a destroyed window
  window.webContents.mainFrame.url = `${ORIGIN}/o/acme`
  assert.equal(resolveNativeSender(invoke(window), registry, ORIGIN).id, 'acme-window')
  window.destroyed = true
  assert.throws(() => resolveNativeSender(invoke(window), registry, ORIGIN), refused)
})

test('the internal holding page remains a trusted sender', () => {
  const registry = orgWindowRegistry()
  const holding = 'data:text/html;charset=utf-8,' + encodeURIComponent('<title>Orgtree — reconnecting</title>')
  const window = fakeWindow(holding)
  registry.register({ ...registration('w1', window), kind: 'homepage' })
  assert.equal(resolveNativeSender(invoke(window), registry, ORIGIN).id, 'w1')
})

// ------------------------------------------------- one notification owner

test('exactly one window owns the app-wide notification duties, and ownership transfers', () => {
  const registry = orgWindowRegistry()
  assert.equal(registry.notificationOwner(), undefined, 'no windows, no owner')
  const first = add(registry, 'w1', 'homepage')
  assert.equal(registry.notificationOwner().id, 'w1')
  add(registry, 'w2', 'org', 'acme')
  add(registry, 'w3', 'org', 'beta')
  assert.equal(registry.notificationOwner().id, 'w1', 'a new window never steals the global poll')
  registry.activate('w3')
  assert.equal(registry.notificationOwner().id, 'w1', 'nor does focusing one')
  assert.deepEqual(registry.list().filter(entry => registry.isNotificationOwner(entry.id)).map(entry => entry.id), ['w1'],
    'exactly one, always')
  first.destroyed = true
  assert.equal(registry.notificationOwner().id, 'w2', 'the owner closing transfers it to the next-earliest')
})

test('a transfer is reported once, so the window that GAINS the duty can be told', () => {
  const registry = orgWindowRegistry()
  const first = add(registry, 'w1', 'homepage')
  add(registry, 'w2', 'org', 'acme')
  registry.reconcileOwnership()
  assert.deepEqual(registry.reconcileOwnership(), { changed: false, owner: 'w1', previous: 'w1', epoch: 1 },
    'reconciling twice is idempotent and reports no phantom transfer')

  first.destroyed = true
  const moved = registry.reconcileOwnership()
  assert.equal(moved.changed, true)
  assert.equal(moved.previous, 'w1')
  assert.equal(moved.owner, 'w2')
  assert.equal(moved.epoch, 2, 'the epoch advances on a real transfer')
  assert.deepEqual(registry.reconcileOwnership(), { changed: false, owner: 'w2', previous: 'w2', epoch: 2 })
  assert.equal(registry.identity('w2').notificationOwner, true, 'and the identity it is told says so')
})

test('NEGATIVE CONTROL: a stale owner cannot write the aggregate after the duty moves', () => {
  // The renderer polls the cross-org projection on mount, on a preference
  // change and on a live bump, so native cannot enforce single ownership by
  // choosing who it WAKES. It enforces who may WRITE, and it asks at the
  // moment of the write - which is exactly what makes an aggregate computed
  // before a transfer and arriving after it get refused.
  const registry = orgWindowRegistry()
  const first = add(registry, 'w1', 'homepage')
  add(registry, 'w2', 'org', 'acme')
  assert.equal(registry.isNotificationOwner('w1'), true)
  assert.equal(registry.isNotificationOwner('w2'), false, 'a non-owner may not write the aggregate')

  // w1 begins a poll, then closes while its async write is in flight
  first.destroyed = true
  assert.equal(registry.isNotificationOwner('w1'), false, 'its late write is refused')
  assert.equal(registry.isNotificationOwner('w2'), true, 'and the new owner is the only writer')
  assert.equal(registry.isNotificationOwner('never-registered'), false)
})

test('the last-used window is tracked separately from notification ownership', () => {
  const registry = orgWindowRegistry()
  add(registry, 'w1', 'homepage')
  const second = add(registry, 'w2', 'org', 'acme')
  assert.equal(registry.lastActivated().id, 'w2')
  registry.activate('w1')
  assert.equal(registry.lastActivated().id, 'w1')
  assert.equal(registry.notificationOwner().id, 'w1')
  second.destroyed = true
  assert.equal(registry.lastActivated().id, 'w1')
  registry.forget('w1')
  assert.equal(registry.lastActivated(), undefined, 'no window, so the caller opens a homepage instead')
})

// --------------------------------------------- unfinished creation forms

test('closing a window with unfinished creation input asks first, and asks only once', () => {
  const registry = orgWindowRegistry()
  add(registry, 'create', 'create')
  assert.equal(registry.beginClose('create'), 'close', 'a clean form closes without a question')
  registry.setUnsavedCreation('create', true)
  assert.equal(registry.beginClose('create'), 'confirm')
  assert.equal(registry.beginClose('create'), 'awaiting',
    'a second close while the prompt is up must not raise a duplicate prompt')

  // declining keeps the window and the draft exactly as they were
  registry.settleClose('create', false)
  assert.deepEqual(registry.identity('create'), { windowId: 'create', kind: 'create', notificationOwner: true })
  assert.equal(registry.beginClose('create'), 'confirm', 'and it still asks next time')

  // confirming discards the draft, so the close that follows proceeds
  registry.settleClose('create', true)
  assert.equal(registry.beginClose('create'), 'close')
})

test('a graceful quit confirms every unfinished form, and a standing prompt aborts it', () => {
  const registry = orgWindowRegistry()
  add(registry, 'create-a', 'create')
  add(registry, 'create-b', 'create')
  add(registry, 'acme-window', 'org', 'acme')
  assert.deepEqual(registry.quitCreationGate(), { action: 'proceed' })

  registry.setUnsavedCreation('create-a', true)
  registry.setUnsavedCreation('create-b', true)
  assert.deepEqual(registry.quitCreationGate(), { action: 'confirm', windowIds: ['create-a', 'create-b'] })

  // one of them already has its own close confirmation on screen: the quit
  // must not ask the same question a second time
  registry.beginClose('create-a')
  assert.deepEqual(registry.quitCreationGate(), { action: 'busy', windowIds: ['create-a'] })
  registry.settleClose('create-a', true)
  assert.deepEqual(registry.quitCreationGate(), { action: 'confirm', windowIds: ['create-b'] })
  registry.settleClose('create-b', true)
  assert.deepEqual(registry.quitCreationGate(), { action: 'proceed' })
})

test('an organization window never reports an unfinished creation form', () => {
  const registry = orgWindowRegistry()
  add(registry, 'acme-window', 'org', 'acme')
  registry.setUnsavedCreation('acme-window', true)
  assert.deepEqual(registry.quitCreationGate(), { action: 'proceed' })
})

// --------------------------------------------------- startup restoration

test('startup reopens every saved window, in order', () => {
  const plan = planRestore([{ org: 'acme' }, {}, { org: 'beta' }])
  assert.deepEqual(plan.windows, [{ org: 'acme' }, {}, { org: 'beta' }])
  assert.deepEqual(plan.skippedOrgs, [])
  assert.equal(plan.homepageFallback, false)
  assert.equal(plan.notice, undefined, 'nothing was unusable, so the user is told nothing')
})

test('NEGATIVE CONTROL: an organization that cannot be found is still reopened', () => {
  // User ruling 2026-09-21, superseding skip-with-a-notice. Nothing can tell a
  // deleted organization from a temporarily unreadable one - a per-org GET
  // maps every failure to 404, authorization included - so skipping on that
  // silence throws away a window the user arranged. It comes back in the
  // ordinary unavailable state instead, and can be recovered in place.
  assert.equal(planRestore.length, 1, 'no existence predicate: nobody can answer it correctly')
  const plan = planRestore([{ org: 'acme' }, { org: 'deleted-yesterday' }, { org: 'unreachable' }])
  assert.deepEqual(plan.windows, [{ org: 'acme' }, { org: 'deleted-yesterday' }, { org: 'unreachable' }],
    'every one of them gets its own window, whatever the catalog says')
  assert.deepEqual(plan.skippedOrgs, [])
  assert.equal(plan.notice, undefined, 'and there is nothing to report, because nothing was dropped')
})

test('a damaged saved record IS skipped, and is the only thing that is', () => {
  // A slug that is not a slug cannot be turned into a route, so there is no
  // window to put into an error state. That is a damaged record rather than an
  // uncertain one, and the distinction is the whole of what survives skipping.
  const plan = planRestore([{ org: 'acme' }, { org: 'Not A Slug' }])
  assert.deepEqual(plan.windows, [{ org: 'acme' }])
  assert.deepEqual(plan.skippedOrgs, ['Not A Slug'])
  assert.match(plan.notice, /the record was damaged \(Not A Slug\)/)
  assert.equal(plan.homepageFallback, false)
})

test('an empty session opens one Homepage, and says so is a fallback', () => {
  const plan = planRestore([])
  assert.deepEqual(plan.windows, [{}])
  assert.equal(plan.homepageFallback, true)
  assert.equal(plan.notice, undefined, 'nothing was skipped, so there is nothing to report')
})

test('a saved homepage window restores as a homepage and is NOT a fallback', () => {
  // It restored exactly what was saved. Nothing stood in for anything, and
  // reporting a fallback here tells the renderer something untrue.
  const plan = planRestore([{}])
  assert.deepEqual(plan.windows, [{}])
  assert.equal(plan.homepageFallback, false)
  assert.equal(plan.notice, undefined)
})

test('a session of nothing but damaged records falls back to a Homepage and reports them', () => {
  const plan = planRestore([{ org: 'Not A Slug' }, { org: 'also bad' }])
  assert.deepEqual(plan.windows, [{}])
  assert.deepEqual(plan.skippedOrgs, ['Not A Slug', 'also bad'])
  assert.equal(plan.homepageFallback, true)
  assert.match(plan.notice, /2 saved windows/)
})

test('native restoration knows nothing about panels, by design', () => {
  // The renderer owns which panels an organization had open, validates its own
  // targets and reports what it could not reopen. Native restores the WINDOW.
  const plan = planRestore([{ org: 'acme', popouts: ['desk-1', 'ghost'] }])
  assert.deepEqual(plan.windows, [{ org: 'acme' }], 'a stray popout list is ignored, not acted on')
  assert.equal('skippedPopouts' in plan, false)
})

// ------------------------------------------------------------------- slugs

test('the organization slug rule is the canonical route rule, with no invented cap', () => {
  for (const slug of ['acme', 'a', 'org-1', 'x@y', '0', 'a'.repeat(400)]) {
    assert.equal(isOrgSlug(slug), true, slug.slice(0, 20))
    assert.equal(isAppPath(`/o/${slug}`), true, 'and the renderer route admits the same name')
  }
  for (const value of ['', 'Acme', 'a b', 'a/b', 'a.b', '../x', null, undefined, 42, {}]) {
    assert.equal(isOrgSlug(value), false, String(value))
  }
})
