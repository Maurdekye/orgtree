import test from 'node:test'
import assert from 'node:assert/strict'
import { TreeSelections } from '../src/treeselection'
import type { TreeSelection } from '../src/treeview'

const fallback: TreeSelection = { include: ['saved'], hideRetired: false, fronts: {} }
test('mounted owners merge protected IDs and closing releases only that owner', () => {
  const state = new TreeSelections(), a = {}, b = {}
  state.set('org', a, { include: ['pinned'], browse: { kind: 'children', parent: '' } })
  state.set('org', b, { include: ['pending-navigation'] })
  assert.deepEqual(new Set(state.read('org', fallback).selection.include), new Set(['saved', 'pinned', 'pending-navigation']))
  const version = state.version('org')
  state.release('org', a)
  assert.notEqual(state.version('org'), version)
  assert.deepEqual(state.read('org', fallback).selection.include, ['saved', 'pending-navigation'])
  assert.equal(state.read('org', fallback).selection.browse, undefined)
  state.release('org', b)
  assert.equal(state.version('org'), 0)
})

test('selection versions invalidate older reads without churn on equivalent input or other orgs', () => {
  const state = new TreeSelections(), owner = {}, events: string[] = []
  const unsubscribe = state.subscribe(org => events.push(org))
  state.set('org', owner, { include: ['b', 'a', 'a'] })
  const first = state.read('org', fallback)
  state.set('org', owner, { include: ['a', 'b'] })
  assert.equal(state.version('org'), first.version)
  state.set('other', owner, { include: ['different'] })
  assert.equal(state.version('org'), first.version)
  state.set('org', owner, { include: ['a'] })
  assert.notEqual(state.version('org'), first.version)
  assert.deepEqual(first.selection.include, ['saved', 'a', 'b'], 'captured requests are immutable')
  assert.deepEqual(events, ['org', 'other', 'org'])
  unsubscribe()
})

test('selection owns copies of caller arrays, saved fronts and browse filters', () => {
  const state = new TreeSelections(), include = ['one'], fronts = { parent: 'last' }
  const browse = { kind: 'search' as const, query: 'old' }
  state.set('org', {}, { include, fronts, browse })
  include.push('two'); fronts.parent = 'changed'; browse.query = 'changed'
  const got = state.read('org', fallback).selection
  assert.deepEqual(got.include, ['saved', 'one'])
  assert.deepEqual(got.fronts, { parent: 'last' })
  assert.deepEqual(got.browse, { kind: 'search', query: 'old' })
})
