import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { withPortalFixture } from './fixtures/portal.mjs'

test('portal fixture returns React-owned content before teardown', async () => {
  await withPortalFixture(async fixture => {
    await fixture.mount(React.createElement('button', { type: 'button' }, 'Open'))
    fixture.moveToPortal()
    assert.equal(fixture.portal.document.querySelector('button')?.textContent, 'Open')
    fixture.returnToMain()
    assert.equal(fixture.main.document.querySelector('button')?.textContent, 'Open')
  })
})

test('failed DOM assertions do not poison the next fixture', async () => {
  await assert.rejects(
    withPortalFixture(async fixture => {
      await fixture.mount(React.createElement('div', null, 'first'))
      fixture.moveToPortal()
      assert.equal(fixture.portal.document.body.textContent, 'deliberately different')
    }),
    /deliberately different/,
  )
  await withPortalFixture(async fixture => {
    await fixture.mount(React.createElement('div', null, 'second'))
    assert.equal(fixture.main.document.body.textContent, 'second')
  })
})
