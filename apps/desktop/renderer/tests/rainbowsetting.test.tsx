import { flush, inAct, mountView } from './harness'
import type { MountedView } from './harness'
import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { applyTheme, ThemeSetting } from '../src/themes'
import type { NativePreferences } from '../src/desktop'
import { DEFAULT_PREFERENCES } from '../../main/policy'
import type { RainbowPreference } from '../src/rainbow'
import { VISUAL_THEMES } from '../../../../packages/contracts/visual-theme'
import type { VisualTheme } from '../../../../packages/contracts/visual-theme'

const toggle = (el: HTMLElement) => el.querySelector<HTMLInputElement>('[role="switch"][aria-label="Rainbow mode"]')
const preference = (enabled: boolean): RainbowPreference => ({ revealed: true, enabled, epoch: 1_730_000_123_456 })

async function setting(t: TestContext, theme: VisualTheme, rainbow: RainbowPreference) {
  const native = window as unknown as { orgtreeDesktop?: unknown }
  const previous = native.orgtreeDesktop
  let saved: NativePreferences = { ...DEFAULT_PREFERENCES, visualTheme: theme, visualThemeExplicit: true, rainbowTheme: { ...rainbow } }
  const writes: Partial<NativePreferences>[] = []
  native.orgtreeDesktop = {
    getPreferences: async () => saved,
    onEvent: () => () => {},
    setPreferences: async (patch: Partial<NativePreferences>) => {
      writes.push(patch); saved = { ...saved, ...patch }; return saved
    },
  }
  let view: MountedView<HTMLElement> | undefined
  t.after(async () => {
    try { await view?.unmount() }
    finally { native.orgtreeDesktop = previous; applyTheme('claude') }
  })
  view = await mountView(<ThemeSetting />, el => el)
  return {
    get el() { return view!.el },
    saved: () => saved,
    writes,
    remount: async () => { await view!.unmount(); view = await mountView(<ThemeSetting />, el => el) },
  }
}

async function selectTheme(el: HTMLElement, value: string) {
  const select = el.querySelector<HTMLSelectElement>('[aria-label="Visual theme"]')!
  await inAct(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await flush()
  })
}

for (const preset of VISUAL_THEMES) {
  test(`revealed Rainbow mode row is absent under the ${preset} preset`, async t => {
    const stored = preference(true), view = await setting(t, preset, stored)
    assert.equal(view.el.querySelector<HTMLSelectElement>('[aria-label="Visual theme"]')!.value, preset)
    assert.equal(toggle(view.el) === null, true, 'the whole Rainbow row is absent, rather than disabled')
    assert.equal(view.el.textContent!.includes('Rainbow mode'), false)
    assert.deepEqual(view.saved().rainbowTheme, stored)
    assert.equal(view.writes.length, 0)
  })
}

for (const enabled of [false, true]) {
  test(`Custom shows the revealed Rainbow toggle with stored enabled=${enabled}`, async t => {
    const stored = preference(enabled), view = await setting(t, 'custom:#8435cf', stored)
    const control = toggle(view.el)
    assert.ok(control)
    assert.equal(control.checked, enabled)
    assert.equal(control.disabled, false)
    assert.deepEqual(view.saved().rainbowTheme, stored)
    assert.equal(view.writes.length, 0)
  })

  test(`switching Custom through every preset and back retains Rainbow enabled=${enabled} and epoch`, async t => {
    const stored = preference(enabled), view = await setting(t, 'custom:#8435cf', stored)
    for (const preset of VISUAL_THEMES) {
      await selectTheme(view.el, preset)
      assert.equal(view.saved().visualTheme, preset)
      assert.equal(toggle(view.el) === null, true, `${preset}: Rainbow row is absent`)
      assert.deepEqual(view.saved().rainbowTheme, stored)
      await selectTheme(view.el, 'custom')
      assert.equal(view.saved().visualTheme, 'custom:#8435cf')
      assert.equal(toggle(view.el)?.checked, enabled)
      assert.deepEqual(view.saved().rainbowTheme, stored)
    }
    await view.remount()
    assert.equal(toggle(view.el)?.checked, enabled)
    assert.deepEqual(view.saved().rainbowTheme, stored)
    assert.equal(view.writes.length, VISUAL_THEMES.length * 2, 'only the theme selections write preferences')
    assert.equal(view.writes.every(patch => !Object.hasOwn(patch, 'rainbowTheme')), true)
  })
}

test('Custom keeps Rainbow mode hidden until the existing reveal gesture', async t => {
  const stored = { revealed: false, enabled: false, epoch: 0 }
  const view = await setting(t, 'custom:#8435cf', stored)
  assert.equal(view.el.querySelector('input[aria-label="Custom theme color"]') !== null, true)
  assert.equal(toggle(view.el) === null, true)
  assert.equal(view.el.textContent!.includes('Rainbow mode'), false)
  assert.deepEqual(view.saved().rainbowTheme, stored)
  assert.equal(view.writes.length, 0)
})
