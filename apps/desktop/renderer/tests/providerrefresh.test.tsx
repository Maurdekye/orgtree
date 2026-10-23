import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountsPanel } from '../src/canvas/accounts'
import { clearProviderDiscovery, getProviders, peekProviders } from '../src/api'
import { desktop } from '../src/desktop'

const payload = (connected = false) => ({ providers: [{ id: 'openai', label: 'Codex', cli: 'Codex', tiers: [],
  status: { installed: true, connected, version: 'fixture' }, hire_enabled: connected }],
  subscription_inference: { openai: true } })
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: {'Content-Type':'application/json'} })

test('explicit provider refresh bypasses an older cached read and coalesces requests', async t => {
  clearProviderDiscovery()
  const old = globalThis.fetch
  t.after(() => { globalThis.fetch = old; clearProviderDiscovery() })
  const requests: { url: string; finish: (value: Response) => void }[] = []
  globalThis.fetch = url => new Promise(resolve => requests.push({url: String(url), finish: resolve}))
  const cached = getProviders()
  const fresh = getProviders(true)
  assert.equal(getProviders(true), fresh)
  assert.equal(getProviders(), fresh)
  assert.deepEqual(requests.map(r => r.url), ['/api/providers', '/api/providers?force=true'])
  requests[1].finish(response(payload(true)))
  await fresh
  requests[0].finish(response(payload(false)))
  await cached
  assert.equal(peekProviders()?.providers[0].status.connected, true, 'older read cannot restore signed-out state')
})

test('default Codex row uses native sign-in and Providers refresh forces discovery', async t => {
  clearProviderDiscovery()
  const oldFetch = globalThis.fetch
  const oldBridge = desktop()
  const calls: string[] = [], logins: unknown[][] = []
  const idle = {phase:'idle',ok:null,timedOut:false,output:'',ageMs:0}
  ;(window as any).orgtreeDesktop = {
    getPreferences: async () => ({visualTheme:'codex',visualThemeExplicit:true}),
    setPreferences: async (patch: unknown) => patch,
    getProviderLoginStatus: async () => idle,
    onEvent: () => () => {},
    startProviderLogin: async (...args: unknown[]) => { logins.push(args); return {...idle,phase:'done',ok:true} },
  }
  globalThis.fetch = async url => {
    calls.push(String(url))
    return response(String(url).startsWith('/api/providers?') || String(url) === '/api/providers' ? payload(logins.length > 0)
      : String(url).includes('/accounts') ? {accounts:[]} : {})
  }
  const view = await mountView(<AccountsPanel toast={() => {}} close={() => {}} />, el => el)
  t.after(async () => { await view.unmount(); globalThis.fetch = oldFetch; (window as any).orgtreeDesktop = oldBridge; clearProviderDiscovery() })
  await inAct(async () => { await flush(10) })
  const row = view.el.querySelector('.native-login')!
  const signIn = [...row.querySelectorAll('button')].find(b => b.textContent === 'Sign in')
  assert.equal(!!signIn, true, 'default Codex login offers Sign in')
  await inAct(async () => { signIn!.click(); await flush(4) })
  assert.deepEqual(logins, [['codex', undefined]], 'default profile reuses existing native flow')
  assert.equal(calls.filter(url => url === '/api/providers?force=true').length, 0,
    'completed native login already verified its provider; do not probe unrelated providers again')
  await inAct(async () => { view.el.querySelector<HTMLButtonElement>('[aria-label="refresh provider status"]')!.click(); await flush(5) })
  assert.equal(calls.filter(url => url === '/api/providers?force=true').length, 1)
})
