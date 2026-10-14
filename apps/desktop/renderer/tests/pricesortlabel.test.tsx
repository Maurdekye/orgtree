// The direction toggle beside "sort [output price]" in the OpenRouter model
// picker (user 2026-10-14: "what does 'dearest first' here mean? opposite of
// cheapest first? weird wording"). A price sort reads "↑ cheapest first" and
// "↓ most expensive first"; the date sort keeps "newest first" / "oldest
// first". The word "dearest" is not shown anywhere in the picker — not in the
// button, its tooltip, or its aria-label. Arrows and behaviour are unchanged:
// choosing a price sort starts cheapest first, a click flips it.
//
// Driven through the real <ModelPicker/> against a scripted catalog endpoint.

import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { ModelPicker } from '../src/canvas/openrouter'
import type { OpenRouterDoc } from '../src/types'

const g = globalThis as unknown as Record<string, unknown>

const DOC = {
  installed: true, connected: true, key_set: true, kind: 'api-key',
  label: 'sk-or-v1-abc…xyz', reason: null, favorites: 0, favorites_max: 0, tiers: [],
  user_enabled: true,
  credits: { limit: null, limit_remaining: null, usage: 0, usage_daily: 0, usage_weekly: 0,
    usage_monthly: 0, is_free_tier: false, checked_at: '2026-10-14T09:00:00Z' },
} as unknown as OpenRouterDoc

/** the picker's search endpoint, answering an empty page for any sort */
function stubCatalog(): void {
  g.fetch = (url: string) => {
    const u = new URL(String(url), 'http://localhost')
    if (u.pathname !== '/api/openrouter/models') {
      return Promise.reject(new Error(`unexpected ${u.pathname}`))
    }
    const payload = { query: '', offset: 0, limit: 8, total: 0, items: [],
      sort: u.searchParams.get('sort') ?? 'relevance', order: u.searchParams.get('order') ?? '' }
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => Promise.resolve(payload) })
  }
}

const reading = (text: string) => [`${text}`, `showing ${text.slice(2)} — click to reverse`,
  `sort direction: ${text.slice(2)}`]

test('the price sorts read "cheapest first" / "most expensive first", never "dearest"',
  async (t: TestContext) => {
    stubCatalog()
    const view = await mountView(
      <ModelPicker doc={DOC} busy={false} onToggle={() => {}} onClose={() => {}} />,
      (el) => el)
    t.after(async () => { await view.unmount(); delete g.fetch })
    await inAct(async () => { await flush(10) })

    const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="sort the catalog"]')!
    assert.ok(select, 'the sort dropdown is rendered')
    const dir = () => view.el.querySelector<HTMLButtonElement>('.orr-dir')
    const read = () => {
      const b = dir()
      assert.ok(b, 'the direction toggle is rendered')
      return [b.textContent?.trim(), b.title, b.getAttribute('aria-label')]
    }
    const choose = async (sort: string) => {
      await inAct(async () => {
        select.value = sort
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await flush(4)
      })
    }
    const flip = async () => { await inAct(async () => { dir()!.click(); await flush(4) }) }

    assert.equal(dir(), null, 'best match has no direction toggle')
    for (const sort of ['output', 'input']) {
      await choose(sort)
      assert.deepEqual(read(), reading('↑ cheapest first'), `${sort} price starts cheapest first`)
      await flip()
      assert.deepEqual(read(), reading('↓ most expensive first'),
        `${sort} price descending reads "most expensive first"`)
      await flip()
      assert.deepEqual(read(), reading('↑ cheapest first'), `${sort} price flips back`)
    }

    // the date sort is untouched
    await choose('recency')
    assert.deepEqual(read(), reading('↓ newest first'), 'release date starts newest first')
    await flip()
    assert.deepEqual(read(), reading('↑ oldest first'), 'release date flips to oldest first')

    // the word is nowhere in what the picker shows: text, tooltips, aria labels
    await choose('output')
    await flip()
    assert.doesNotMatch(view.el.innerHTML, /dearest/i, 'no "dearest" anywhere in the picker')
  })
