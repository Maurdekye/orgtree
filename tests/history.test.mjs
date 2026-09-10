import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const dir = fs.mkdtempSync(path.resolve('node_modules/.history-test-'))
const output = path.join(dir, 'history.cjs')
await build({ entryPoints: ['apps/desktop/renderer/src/history.tsx'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'history-fixtures', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, args => args.importer.endsWith('history.tsx') ? ({ path: 'api', namespace: 'fixture' }) : undefined)
    build.onResolve({ filter: /^\.\/canvas\/modalpin$/ }, () => ({ path: 'frame', namespace: 'fixture' }))
     build.onResolve({ filter: /^\.\/icons$/ }, () => ({ path: 'icons', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'api'
      ? 'export const req = (...args) => globalThis.historyRequest(...args)'
      : args.path === 'icons'
        ? 'import React from "react"; const I = ({fontSize, ...props}) => React.createElement("span", props); export const AutorenewIcon=I, ArrowUpIcon=I, FolderIcon=I, HomeIcon=I, StorageIcon=I, AddIcon=I, ArrowDownIcon=I, ChevronLeftIcon=I, ChevronRightIcon=I, CloseIcon=I, PinIcon=I, SettingsIcon=I, DeleteIcon=I'
      : 'import React from "react"; export const PinFrame = ({children}) => React.createElement("section", null, children)',
      resolveDir: process.cwd() }))
  }}] })

test('history browse replaces bounded pages, changes collections and recovers from expired cursor', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'http://localhost' })
  globalThis.window = dom.window; globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.localStorage = window.localStorage
  const { HistoryView } = createRequire(import.meta.url)(output)
  const calls = []
  let expired = false
  globalThis.historyRequest = async url => {
    calls.push(url)
    if (url.endsWith('/history')) return { collections: [
      {id:'user-mail',label:'Read user mail',needs_node:false},
      {id:'chat',label:'Chat transcript',needs_node:true}], nodes:[{id:'agent',state:'archived',generation:1}] }
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor')
    if (cursor && expired) throw new Error('History changed while browsing. Refresh to start again.')
    if (url.includes('/chat?')) return {items:[{text:'old transcript message',role:'assistant'}],total:1,next_cursor:null}
    return cursor ? {items:[{body:'oldest retained mail',at:'yesterday'}],total:3,next_cursor:null}
      : {items:[{body:'newest mail'},{body:'second mail'}],total:3,next_cursor:'older'}
  }
  const root = createRoot(document.getElementById('app'))
  const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text || b.getAttribute('aria-label') === text)
  await act(async () => root.render(React.createElement(HistoryView, {slug:'fixture'})))
  assert.match(document.body.textContent, /newest mail/)
  assert.equal(document.querySelectorAll('details').length,2)
  await act(async () => button('Older').click())
  assert.match(document.body.textContent, /oldest retained mail/)
  assert.doesNotMatch(document.body.textContent, /newest mail/)
  assert.equal(document.querySelectorAll('details').length,1)
  assert.equal(button('Older').disabled,true)
  await act(async () => button('Newer').click())
  expired = true
  await act(async () => button('Older').click())
  assert.match(document.querySelector('[role=alert]').textContent, /History changed/)
  await act(async () => button('Refresh history').click())
  assert.match(document.body.textContent,/newest mail/)
  const select=document.querySelector('[aria-label="History records"]')
  await act(async () => { select.value='chat';select.dispatchEvent(new window.Event('change',{bubbles:true})) })
  assert.match(document.body.textContent,/old transcript message/)
  assert.match(document.querySelector('[aria-label="History agent"]').textContent,/agent \(archived\)/)
  assert.ok(calls.some(url=>url.includes('/chat?') && url.includes('node=agent')))
  await act(async () => root.unmount())
  dom.window.close()
})
