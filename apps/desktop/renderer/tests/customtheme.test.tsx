import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ThemeSetting, startThemeSync } from '../src/themes'
import { isVisualTheme } from '../../../../packages/contracts/visual-theme'

test('Custom reveals a picker, applies the selected color, and restores after remount', async () => {
  localStorage.clear()
  localStorage.setItem('orgtree-visual-theme', 'orgtree')
  let view = await mountView(<ThemeSetting />, el => el)
  const change = async (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    await inAct(async () => {
      const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLSelectElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el,value)
      el.dispatchEvent(new window.Event('change',{bubbles:true})); await flush()
    })
  }
  try {
    assert.equal(view.el.querySelector('input[type=color]'),null)
    await change(view.el.querySelector('select')!, 'custom')
    const picker = view.el.querySelector<HTMLInputElement>('input[type=color]')!
    assert.ok(picker, 'Custom exposes the actual picker')
    await change(picker, '#8435cf')
    assert.equal(document.documentElement.style.getPropertyValue('--accent'),'#8435cf')
    assert.equal(localStorage.getItem('orgtree-visual-theme'),'custom:#8435cf')
    await view.unmount()
    const stop = startThemeSync()
    view = await mountView(<ThemeSetting />, el => el)
    try {
      assert.equal(view.el.querySelector('select')!.value,'custom')
      assert.equal(view.el.querySelector<HTMLInputElement>('input[type=color]')!.value,'#8435cf')
      assert.equal(document.documentElement.style.getPropertyValue('--accent'),'#8435cf')
      await change(view.el.querySelector('select')!,'claude')
      assert.equal(view.el.querySelector('input[type=color]'),null)
    } finally { stop() }
  } finally { await view.unmount(); localStorage.clear() }
  assert.equal(isVisualTheme('custom:#ffffff'),true)
  assert.equal(isVisualTheme('custom:garbage'),false)
})
