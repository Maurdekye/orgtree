import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import Module from 'node:module'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-theme-test-'))
const dependencyRoot = path.dirname(path.dirname(createRequire(import.meta.url).resolve('react/package.json')))
process.env.NODE_PATH = [dependencyRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()
const output = path.join(dir, 'themes.cjs')
await build({entryPoints:['apps/desktop/renderer/src/themes.tsx'],outfile:output,bundle:true,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']})

test('Display persists only appearance, honors broadcasts over stale load, and reports save failure', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost'})
  globalThis.window=dom.window;globalThis.document=dom.window.document
  globalThis.localStorage=window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const {ThemeSetting,startThemeSync,THEMES}=createRequire(import.meta.url)(output)
  const listeners=new Set(), requests=[], pending=[]
  let value={visualTheme:'claude',visualThemeExplicit:true}, fail=false
  window.orgtreeDesktop={getPreferences:()=>new Promise(resolve=>pending.push(resolve)),onEvent:f=>{listeners.add(f);return()=>listeners.delete(f)},setPreferences:async patch=>{
    requests.push(patch);if(fail)throw Error('Disk unavailable');value={...value,...patch}
    for(const f of listeners)f({type:'preferences',data:value});return value
  }}
  const stop=startThemeSync(),root=createRoot(document.getElementById('app'))
  await act(async()=>root.render(React.createElement(ThemeSetting)))
  await act(async()=>{for(const f of listeners)f({type:'preferences',data:{visualTheme:'codex',visualThemeExplicit:true}});pending.forEach(f=>f({visualTheme:'claude',visualThemeExplicit:true}))})
  const select=document.querySelector('select')
  assert.equal(select.value,'codex');assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.codex.accent)
  for(const id of Object.keys(THEMES))await act(async()=>{select.value=id;select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  assert.deepEqual(requests,Object.keys(THEMES).map(visualTheme=>({visualTheme,visualThemeExplicit:true})))
  fail=true
  await act(async()=>{select.value='claude';select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  assert.match(document.querySelector('[role=alert]').textContent,/Disk unavailable/)
  assert.equal(select.value,'openrouter')
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.openrouter.accent)
  assert.equal(document.documentElement.style.length,7,'only accent tokens and their organization copies changed')
  await act(async()=>root.unmount());stop();assert.equal(listeners.size,0);dom.window.close()
})

test('fresh theme follows installed-provider priority without persisting a provisional fallback', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost'})
  globalThis.window=dom.window;globalThis.document=dom.window.document
  globalThis.localStorage=window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  delete window.orgtreeDesktop
  const {startThemeSync,defaultThemeForProviders,THEMES}=createRequire(import.meta.url)(output)
  const pending=[]
  globalThis.fetch=async()=>new Promise(resolve=>pending.push(resolve))
  assert.equal(defaultThemeForProviders({providers:[{id:'claude',status:{installed:true}},{id:'openai',status:{installed:true}}]}),'claude')
  assert.equal(defaultThemeForProviders({providers:[{id:'google',status:{installed:true}},{id:'openai',status:{installed:true}}]}),'codex')
  assert.equal(defaultThemeForProviders({providers:[{id:'google',status:{installed:true}}]}),'antigravity')
  assert.equal(defaultThemeForProviders({providers:[]}),'claude')
  const stop=startThemeSync()
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.claude.accent)
  assert.equal(localStorage.getItem('orgtree-visual-theme'),null,'unresolved detection does not persist the provisional Claude fallback')
  assert.equal(pending.length,1)
  pending[0]({ok:true,status:200,headers:new Headers(),json:async()=>({providers:[{id:'openai',status:{installed:true}}]})})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.codex.accent)
  assert.equal(localStorage.getItem('orgtree-visual-theme'),null,'detected defaults remain unset')
  stop()
  localStorage.setItem('orgtree-visual-theme','claude')
  const reloadClaude=startThemeSync()
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.claude.accent)
  reloadClaude()
  localStorage.setItem('orgtree-visual-theme','codex')
  const reloadCodex=startThemeSync()
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.codex.accent)
  reloadCodex();dom.window.close()
})

test('mounted ThemeSetting keeps a choice made before provider detection resolves', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost'})
  globalThis.window=dom.window;globalThis.document=dom.window.document
  globalThis.localStorage=dom.window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  delete window.orgtreeDesktop
  const {ThemeSetting,THEMES}=createRequire(import.meta.url)(output)
  const pending=[]
  globalThis.fetch=async()=>new Promise(resolve=>pending.push(resolve))
  const root=createRoot(document.getElementById('app'))
  await act(async()=>root.render(React.createElement(ThemeSetting)))
  const select=document.querySelector('select')
  assert.equal(select.disabled,false)
  await act(async()=>{select.value='codex';select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  assert.equal(select.value,'codex')
  pending[0]({ok:true,status:200,headers:new Headers(),json:async()=>({providers:[{id:'google',status:{installed:true}}]})})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(select.value,'codex')
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.codex.accent)
  await act(async()=>root.unmount());dom.window.close()
})
test('native bridge receives the effective Codex default for an installed Codex-only payload', async () => {
  const dom = new JSDOM('<div id="app"></div>', {url:'http://localhost'})
  globalThis.window=dom.window;globalThis.document=dom.window.document
  globalThis.localStorage=dom.window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const {startThemeSync,THEMES}=createRequire(import.meta.url)(output)
  const effective=[]
  window.orgtreeDesktop={
    getPreferences:()=>Promise.resolve({visualTheme:'orgtree',visualThemeExplicit:false}),
    onEvent:()=>()=>{},
    setEffectiveTheme:async theme=>{effective.push(theme)},
    setPreferences:async patch=>({visualTheme:'orgtree',visualThemeExplicit:false,...patch}),
  }
  globalThis.fetch=async()=>({ok:true,status:200,headers:new Headers(),json:async()=>({providers:[{id:'openai',status:{installed:true}}]})})
  const stop=startThemeSync()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(effective[0],'claude')
  assert.equal(effective.at(-1),'codex')
  assert.equal(document.documentElement.style.getPropertyValue('--accent'),THEMES.codex.accent)
  stop();dom.window.close()
})
