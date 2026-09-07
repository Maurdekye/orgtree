// Focused coverage for the two controls whose network reads used to collapse
// failure into an indistinguishable blank/empty state.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SettingsPanel } from '../src/App'
import { DraftNode } from '../src/canvas/cards'
import type { DraftState } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>
type Seen = { path: string; method: string }

function tree(slug = 'acme'): TreePayload {
  return { slug, name: slug, nodes: [], edges: [],
    cascade_hire: true, cascade_alloc: true, net: { hubs: [] }, kiosk: null,
  } as unknown as TreePayload
}

function response(payload: unknown) {
  return { ok: true, status: 200, headers: new Headers(),
    json: () => Promise.resolve(payload) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function settle() {
  await inAct(async () => { await flush(10) })
}

async function setText(el: HTMLTextAreaElement, value: string) {
  const w = el.ownerDocument.defaultView!
  const setter = Object.getOwnPropertyDescriptor(
    w.HTMLTextAreaElement.prototype, 'value')?.set
  assert.ok(setter)
  await inAct(async () => {
    setter!.call(el, value)
    el.dispatchEvent(new w.Event('input', { bubbles: true }))
    el.dispatchEvent(new w.Event('change', { bubbles: true }))
  })
}

test('org.md distinguishes pending, failed, empty success, and success, with retry',
  async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const seen: Seen[] = []
    let reads = 0
    g.fetch = (url: string) => {
      const path = new URL(url, 'http://localhost').pathname
      seen.push({ path, method: 'GET' })
      if (path === '/api/providers') return Promise.resolve(response({ providers: [] }))
      if (path === '/api/orgs/acme/orgmd') {
        reads += 1
        return (reads === 1 ? first.promise : second.promise)
      }
      return Promise.reject(new Error(`unexpected GET ${path}`))
    }
    const view = await mountView(
      <SettingsPanel tree={tree()} toast={() => {}} close={() => {}} />, (el) => el)
    try {
      assert.match(view.el.textContent ?? '', /Loading org\.md/)
      assert.equal(view.el.querySelector<HTMLTextAreaElement>('[aria-label="org.md"]')!.disabled,
        true)
      first.reject(new Error('network down'))
      await settle()
      assert.match(view.el.textContent ?? '', /Unable to load org\.md/)
      const retry = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'Retry')
      assert.ok(retry)
      await inAct(async () => { retry!.click() })
      assert.match(view.el.textContent ?? '', /Loading org\.md/)
      second.resolve(response({ path: 'org.md', content: '' }))
      await settle()
      assert.match(view.el.textContent ?? '', /No org\.md charter is configured/)
      const editor = view.el.querySelector<HTMLTextAreaElement>('[aria-label="org.md"]')!
      assert.equal(editor.disabled, false)
      assert.equal(editor.value, '')
    } finally {
      await view.unmount(); delete g.fetch
    }
    assert.equal(seen.filter((x) => x.path.endsWith('/orgmd')).length, 2)
  })

test('org.md oversized read stays disabled and save does not write a partial copy',
  async () => {
    const seen: Array<{ path: string; method: string; body?: string }> = []
    g.fetch = (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname
      const method = init?.method ?? 'GET'
      seen.push({ path, method, body: init?.body?.toString() })
      if (path === '/api/providers') return Promise.resolve(response({ providers: [] }))
      if (path === '/api/orgs/acme/orgmd' && method === 'GET')
        return Promise.resolve(response({ content: 'partial', chars: 9000,
          edit_max: 8000, read_truncated: true }))
      if (path === '/api/orgs/acme/settings' && method === 'POST')
        return Promise.resolve(response({}))
      return Promise.reject(new Error(`unexpected ${method} ${path}`))
    }
    const view = await mountView(
      <SettingsPanel tree={tree()} toast={() => {}} close={() => {}} />, (el) => el)
    try {
      await settle()
      assert.match(view.el.textContent ?? '', /partial copy cannot be saved/)
      const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'save')!
      await inAct(async () => { save.click(); await flush(10) })
      assert.equal(seen.some((x) => x.path.endsWith('/orgmd') && x.method === 'PUT'), false)
      assert.equal(view.el.querySelector<HTMLTextAreaElement>('[aria-label="org.md"]')!.disabled,
        true)
    } finally {
      await view.unmount(); delete g.fetch
    }
  })

test('a normal full org.md buffer remains editable and saves the whole buffer',
  async () => {
    const seen: Array<{ path: string; method: string; body?: string }> = []
    g.fetch = (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname
      const method = init?.method ?? 'GET'
      seen.push({ path, method, body: init?.body?.toString() })
      if (path === '/api/providers') return Promise.resolve(response({ providers: [] }))
      if (path === '/api/orgs/acme/orgmd' && method === 'GET')
        return Promise.resolve(response({ content: 'whole charter', chars: 13,
          read_truncated: false }))
      if (path === '/api/orgs/acme/settings' && method === 'POST')
        return Promise.resolve(response({}))
      if (path === '/api/orgs/acme/orgmd' && method === 'PUT')
        return Promise.resolve(response({ path: 'org.md', bytes: 12, chars: 12 }))
      return Promise.reject(new Error(`unexpected ${method} ${path}`))
    }
    const view = await mountView(
      <SettingsPanel tree={tree()} toast={() => {}} close={() => {}} />, (el) => el)
    try {
      await settle()
      const editor = view.el.querySelector<HTMLTextAreaElement>('[aria-label="org.md"]')!
      assert.equal(editor.disabled, false)
      await setText(editor, 'edited whole')
      const save = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent?.trim() === 'save')!
      await inAct(async () => { save.click(); await flush(10) })
      const put = seen.find((x) => x.method === 'PUT' && x.path.endsWith('/orgmd'))
      assert.ok(put, 'full org.md save did not send its PUT')
      assert.deepEqual(JSON.parse(put!.body ?? '{}'), { content: 'edited whole' })
    } finally {
      await view.unmount(); delete g.fetch
    }
  })

test('a delayed org.md response from a previous org cannot overwrite the current org',
  async () => {
    const oldRead = deferred<unknown>()
    const newRead = deferred<unknown>()
    g.fetch = (url: string) => {
      const path = new URL(url, 'http://localhost').pathname
      if (path === '/api/providers') return Promise.resolve(response({ providers: [] }))
      if (path === '/api/orgs/acme/orgmd') return oldRead.promise
      if (path === '/api/orgs/beta/orgmd') return newRead.promise
      return Promise.reject(new Error(`unexpected GET ${path}`))
    }
    const view = await mountView(
      <SettingsPanel tree={tree()} toast={() => {}} close={() => {}} />, (el) => el)
    try {
      await view.render(
        <SettingsPanel tree={tree('beta')} toast={() => {}} close={() => {}} />)
      newRead.resolve(response({ content: 'new org' }))
      await settle()
      oldRead.resolve(response({ content: 'old org' }))
      await settle()
      assert.equal(view.el.querySelector<HTMLTextAreaElement>('[aria-label="org.md"]')!.value,
        'new org')
    } finally {
      await view.unmount(); delete g.fetch
    }
  })

test('preset failure has retry while manual charter remains usable', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let reads = 0
  let confirmed = ''
  g.fetch = (url: string) => {
    const path = new URL(url, 'http://localhost').pathname
    if (path === '/api/charters') {
      reads += 1
      return (reads === 1 ? first.promise : second.promise)
    }
    return Promise.reject(new Error(`unexpected GET ${path}`))
  }
  const draft: DraftState = { parent: null, tier: 'haiku' }
  const view = await mountView(
    <DraftNode pos={{ x: 0, y: 0 }} draft={draft} map={new Map()}
      seats={{ haiku: 1 }} maxTop={100} defaultTop={0} kioskRemaining={null}
      tree={tree()} zoom={1} pxc={1}
      onConfirm={(_name, _grant, charter) => { confirmed = charter }}
      onCancel={() => {}} />, (el) => el)
  try {
    assert.match(view.el.textContent ?? '', /Loading charter presets/)
    const editor = view.el.querySelector<HTMLTextAreaElement>('.df-charter')!
    await setText(editor, 'manual role')
    first.reject(new Error('presets unavailable'))
    await settle()
    assert.match(view.el.textContent ?? '', /Unable to load charter presets/)
    assert.equal(view.el.querySelector<HTMLTextAreaElement>('.df-charter')!.value,
      'manual role')
    const retry = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.trim() === 'Retry')
    assert.ok(retry)
    await inAct(async () => { retry!.click() })
    second.resolve(response({ charters: [{ name: 'Short', content: 'preset role', path: 'short.md' }] }))
    await settle()
    const select = view.el.querySelector<HTMLSelectElement>('.df-preset-add')
    assert.ok(select)
    await inAct(async () => {
      select!.value = 'Short'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
      await flush(4)
    })
    assert.equal(view.el.querySelector<HTMLTextAreaElement>('.df-charter')!.value,
      'manual role')
    const hire = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('hire'))!
    await inAct(async () => { hire.click() })
    assert.equal(confirmed, 'preset role\n\nmanual role')
  } finally {
    await view.unmount(); delete g.fetch
  }
})

test('uninitialized hire keeps long manual charter without an advisory warning', async () => {
  let confirmed = ''
  g.fetch = (url: string) => {
    const path = new URL(url, 'http://localhost').pathname
    if (path === '/api/charters')
      return Promise.resolve(response({ charter_long: 4, charters: [] }))
    return Promise.reject(new Error(`unexpected GET ${path}`))
  }
  const view = await mountView(
    <DraftNode pos={{ x: 0, y: 0 }} draft={{ parent: null, tier: 'haiku' }}
      map={new Map()} seats={{ haiku: 1 }} maxTop={100} defaultTop={0}
      kioskRemaining={null} tree={tree()} zoom={1} pxc={1}
      onConfirm={(_name, _grant, charter) => { confirmed = charter }}
      onCancel={() => {}} />, (el) => el)
  try {
    await settle()
    const editor = view.el.querySelector<HTMLTextAreaElement>('.df-charter')!
    await setText(editor, 'a deliberately long manual charter')
    assert.equal(view.el.querySelector('.df-charter-note'), null)
    assert.doesNotMatch(view.el.textContent ?? '', /stored whole|costs\s+tokens/)
    const name = view.el.querySelector<HTMLInputElement>('.df-name')!
    await inAct(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value')?.set
      setter!.call(name, 'long-charter-agent')
      name.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const hire = [...view.el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('hire'))!
    await inAct(async () => { hire.click(); await flush(4) })
    assert.equal(confirmed, 'a deliberately long manual charter')
  } finally {
    await view.unmount(); delete g.fetch
  }
})
