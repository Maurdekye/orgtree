import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
const dir = fs.mkdtempSync(path.resolve('node_modules/.theme-test-'))
const output = path.join(dir, 'themes.cjs')
await build({entryPoints:['apps/desktop/renderer/src/themes.tsx'],outfile:output,bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']})

test('Display persists only appearance, honors broadcasts over stale load, and reports save failure', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost'})
  globalThis.window=dom.window;globalThis.document=dom.window.document
  globalThis.localStorage=window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const {ThemeSetting,startThemeSync,THEMES}=createRequire(import.meta.url)(output)
  const listeners=new Set(), requests=[], pending=[]
  let value={visualTheme:'claude'}, fail=false
  window.orgtreeDesktop={getPreferences:()=>new Promise(resolve=>pending.push(resolve)),onEvent:f=>{listeners.add(f);return()=>listeners.delete(f)},setPreferences:async patch=>{
    requests.push(patch);if(fail)throw Error('Disk unavailable');value={...value,...patch}
    for(const f of listeners)f({type:'preferences',data:value});return value
  }}
  const stop=startThemeSync(),root=createRoot(document.getElementById('app'))
  await act(async()=>root.render(React.createElement(ThemeSetting)))
  await act(async()=>{for(const f of listeners)f({type:'preferences',data:{visualTheme:'codex'}});pending.forEach(f=>f({visualTheme:'claude'}))})
  const select=document.querySelector('select')
  assert.equal(select.value,'codex');assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.codex.accent)
  for(const id of Object.keys(THEMES))await act(async()=>{select.value=id;select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  assert.deepEqual(requests,Object.keys(THEMES).map(visualTheme=>({visualTheme})))
  fail=true
  await act(async()=>{select.value='claude';select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  assert.match(document.querySelector('[role=alert]').textContent,/Disk unavailable/)
  assert.equal(select.value,'openrouter')
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.openrouter.accent)
  assert.equal(document.documentElement.style.length,4,'only four appearance tokens changed')
  await act(async()=>root.unmount());stop();assert.equal(listeners.size,0);dom.window.close()
})
