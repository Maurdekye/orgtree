// The agent settings "States" tab is now "Activity" and sits directly left of History (USER 2026-11-04 m5d5ae90b5b7b,
// mc8352401b5c2). Internal ids stay (`states`).
import './testguard.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentSettingsTabs } from '../src/canvas/modals'

test('the strip reads Charter, Model, Scope, Tools, Activity, History: Activity directly left of History', () => {
  assert.deepEqual(agentSettingsTabs(true).map(t => t.label), ['Charter', 'Model', 'Scope', 'Tools', 'Activity', 'History'])
  assert.deepEqual(agentSettingsTabs(true).map(t => t.id), ['charter', 'model', 'scope', 'tools', 'states', 'history'], 'ids unchanged')
})

test('with no history records Activity still shows, last; nothing is called States', () => {
  assert.deepEqual(agentSettingsTabs(false).map(t => t.label), ['Charter', 'Model', 'Scope', 'Tools', 'Activity'])
  assert.ok(![...agentSettingsTabs(true), ...agentSettingsTabs(false)].some(t => /states/i.test(t.label)))
})
