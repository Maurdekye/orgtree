// RT-P (spec R11): a converted surface popped out into another window keeps
// KaTeX styling (popouts clone the app's stylesheets, and the KaTeX CSS is
// part of them) and working mention chips (bound per host element).
import { flush, inAct, JSDOM, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createPortal } from 'react-dom'
import { RefMdBody } from '../src/canvas/refmd'
import { md } from '../src/canvas/shared'
import { DocketList } from '../src/canvas/docket'
import { RICH, expectRich, onOpen, opened, world } from './fixtures/richformat'

declare const __SRC_DIR__: string

test('RT-P the KaTeX stylesheet is part of the app styles every popout clones', () => {
  const css = readFileSync(path.join(__SRC_DIR__, 'styles.css'), 'utf8')
  assert.match(css, /@import\s+['"]katex\/dist\/katex\.min\.css['"]/)
  const popout = readFileSync(path.join(__SRC_DIR__, 'popout.tsx'), 'utf8')
  assert.match(popout, /querySelectorAll\('style, link\[rel="stylesheet"\]'\)/, 'popouts clone every style and stylesheet link')
})

test('RT-P a converted docket list rendered into another window shows rich text and its chips open', async t => {
  const other = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div></body></html>', { url: 'http://localhost/' })
  const host = other.window.document.getElementById('host')!
  opened.length = 0
  const view = await mountView(createPortal(
    <DocketList heading="X" items={[RICH]} mark="done" refIndex={new Map() as never} refWorld={world} onOpenRef={onOpen} />, host), el => el)
  t.after(() => view.unmount())
  await inAct(async () => { await flush(3) })
  expectRich(host)
  const chip = host.querySelector('[data-ref-token="@item:t/sample-item"]') as HTMLElement
  assert.ok(chip)
  await inAct(async () => { chip.dispatchEvent(new other.window.MouseEvent('click', { bubbles: true, cancelable: true })); await flush(2) })
  assert.equal(opened.length, 1, 'a chip click in the other window opens the mention')
})
