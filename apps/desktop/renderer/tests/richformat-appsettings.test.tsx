// C18 (spec §2.2, rev 1.2 D2): the custom app description in App settings renders
// rich text, and a mention chip in it opens through the shell's own routes.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AppSettings } from '../src/canvas/apps/settings'
import { AppsRefRoutes } from '../src/canvas/apps/events'
import { ORG, RICH, expectRich, opened, refs } from './fixtures/richformat'

test('RT-C18 the app description renders Markdown, LaTeX and mentions, and a chip opens', async t => {
  const app = { id: 'notes', name: 'Notes', description: RICH, rev: 1, width: 360, height: 280, capabilities: [], events: [], permissions: {},
    created_by: 'maker', updated_at: '' }
  const original = globalThis.fetch
  globalThis.fetch = (async (raw: unknown, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://local')
    const input = init?.method === 'POST' ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('request') ?? '{}')
    const out = input.action === 'list' ? { items: input.kind === 'apps' ? [app] : [], next_cursor: null } : {}
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = original })
  const view = await mountView(<AppsRefRoutes.Provider value={refs}><AppSettings slug={ORG} app={app as never} close={() => {}} /></AppsRefRoutes.Provider>, el => el)
  t.after(() => view.unmount())
  await inAct(async () => { for (let i = 0; i < 5; i++) await flush() })
  const description = document.querySelector('.app-description')
  assert.ok(description, 'the description rendered')
  expectRich(description!)
  opened.length = 0
  const chip = description!.querySelector('[data-ref-token="@item:t/sample-item"]') as HTMLElement
  await inAct(async () => { chip.click(); await flush(2) })
  assert.equal(opened.length, 1, 'the chip opens the mention')
})
