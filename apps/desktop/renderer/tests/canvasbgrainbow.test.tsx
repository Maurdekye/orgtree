// canvasbgrainbow.test.tsx: the ascii background re-reads its ink only when a
// root change could move it. The rainbow theme writes `--rainbow-accent` on
// <html> about 30 times a second (rainbow.ts), and the background's
// MutationObserver on <html> style answered every write with
// getComputedStyle(host): a forced full-document style recalc per frame. Its
// ink is `color: var(--dim)`, which the rainbow never sets. Not claimed as the
// 4.6.1 desk-load hang fix: a waste removal (desk-freeze-opus 2026-11-15).
// Run: node apps/desktop/renderer/tests/run.mjs canvasbgrainbow
import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { watchRootColours } from '../src/canvas/canvasbackground'

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('rainbow frames do not re-read the ink; theme, class and other style changes still do', async (t) => {
  const root = document.documentElement
  const saved = root.getAttribute('style')
  let reads = 0
  const stop = watchRootColours(document, () => { reads++ })
  t.after(() => { stop(); if (saved === null) root.removeAttribute('style'); else root.setAttribute('style', saved) })

  for (let i = 0; i < 30; i++) {
    root.style.setProperty('--rainbow-accent', `hsl(${i * 12} 70% 50%)`)
    await settle()
  }
  assert.equal(reads, 0, `30 rainbow frames scheduled ${reads} ink re-read(s); each one forces a full style recalc`)

  root.style.setProperty('--accent', 'red')
  await settle()
  assert.equal(reads, 1, 'a real root style change must still re-read the ink')

  root.setAttribute('data-visual-theme', 'custom:#336699')
  await settle()
  assert.equal(reads, 2, 'a theme switch must still re-read the ink')

  root.classList.add('contrast-high')
  await settle()
  assert.equal(reads, 3, 'a root class change must still re-read the ink')
  root.classList.remove('contrast-high')
  root.removeAttribute('data-visual-theme')
  root.style.removeProperty('--accent')
})
