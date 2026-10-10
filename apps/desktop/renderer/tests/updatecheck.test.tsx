import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeCheck, UpdateCheckRow } from '../src/canvas/updatecheck'
import type { NativeDesktop } from '../src/desktop'

test('the check result is said in plain words for every state', () => {
  assert.equal(describeCheck({ state: 'idle' }, '4.2.0'), null)
  assert.equal(describeCheck({ state: 'checking' }, '4.2.0'), 'Checking…')
  assert.equal(describeCheck({ state: 'up-to-date' }, '4.2.0'), 'Orgtree is up to date (4.2.0).')
  assert.match(describeCheck({ state: 'downloading', version: '4.2.1' }, '4.2.0')!, /^Version 4\.2\.1 is available/)
  assert.match(describeCheck({ state: 'pending-idle', version: '4.2.1' }, '4.2.0')!, /^Version 4\.2\.1 is ready to install/)
  assert.match(describeCheck({ state: 'unavailable', error: 'net::ERR_INTERNET_DISCONNECTED' }, '4.2.0')!, /Could not check for updates: net::ERR_INTERNET_DISCONNECTED/)
  assert.match(describeCheck({ state: 'unavailable', error: 'This build has no update feed.' }, null)!, /no update feed/)
})

test('the row shows the result of a click and then an error', async () => {
  const answers = [{ state: 'downloading', version: '4.2.1' }, { state: 'unavailable', error: 'offline' }]
  const bridge = { onEvent: () => () => {}, getUpdateStatus: async () => ({ state: 'idle' }),
    checkForUpdates: async () => answers.shift() } as unknown as NativeDesktop
  Object.defineProperty(window, 'orgtreeDesktop', { value: bridge, configurable: true })
  const v = await mountView(<UpdateCheckRow appVersion="4.2.0-alpha.1" />, el => el)
  try {
    const button = v.el.querySelector('button')!
    await inAct(async () => { button.click(); await flush(5) })
    assert.match(v.el.textContent!, /Version 4\.2\.1 is available/)
    await inAct(async () => { button.click(); await flush(5) })
    assert.match(v.el.textContent!, /Could not check for updates: offline/)
  } finally { await v.unmount(); Object.defineProperty(window, 'orgtreeDesktop', { value: undefined, configurable: true }) }
})
