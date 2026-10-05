import './harness'
import { inAct, mountView } from './harness'
import React from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RecordFeed } from '../src/recordfeed'
import { RecordTreeSelection } from '../src/recordtreeselection'
import { projectTree } from '../src/recordprojection'
import { hydrateTree } from '../src/archived'
import { OrgRecordContext, useOrgRecords } from '../src/recordsession'

// This reached integration control is run by test_orgdb_record_selection_pg,
// under the heavy slot. Ordinary renderer runs explicitly skip it because
// neither generated bodies nor a hand-written fixture proves SQL parity.
test('real PostgreSQL pages project full display for 300 pins, all and children, then live/archive catch-ups',
  { skip: !process.env.ORGTREE_RECORD_SELECTION_FIXTURE }, async () => {
    const fixture = JSON.parse(readFileSync(process.env.ORGTREE_RECORD_SELECTION_FIXTURE!, 'utf8'))
    // Account cards/continue choices are B4b app overlays; local detail tokens
    // and unloaded lineage have deliberately different wire representations.
    const ignored = new Set([...fixture.runtime_keys, 'continue_accounts', 'serving_account', 'ran_as_label',
      'account_label', 'account_tint_ordinal', 'name', 'created', 'ui_order', 'ord', 'axis',
      'predecessor', 'successor', 'lineage', 'lineage_count', 'lineage_loaded', 'consultable_predecessor', 'detail_rev'])
    const display = (tree: any) => {
      const node = (n: any, parent: string | null): any => ({
        ...Object.fromEntries(Object.entries(n).filter(([key]) => key !== 'children' && !ignored.has(key))),
        // Full legacy trees encode parents through nesting; foreground records
        // additionally carry the name. Check the latter against that nesting.
        parent: Object.hasOwn(n, 'parent') ? n.parent : parent,
        hidden_retired_children: n.hidden_retired_children ?? 0,
        children: (n.children ?? []).map((child: any) => node(child, n.id)),
      })
      return { ...Object.fromEntries(fixture.header_keys.map((key: string) => [key, tree[key]])),
        org_rev: tree.org_rev, roots: tree.roots.map((root: any) => node(root, null)) }
    }
    for (const example of fixture.cases) {
      let reads = 0
      const messages: any[] = [], errors: Error[] = []
      const feed = new RecordFeed({ snapshot: async () => { throw new Error('no baseline refetch') },
        catchup: async () => { throw new Error('no HTTP catch-up in this socket control') },
        project: (rows, state) => projectTree(rows, { runtime: state.runtime, cursor: state.cursor }),
        publish: () => {}, error: e => errors.push(e) })
      const token = feed.socketOpened(message => messages.push(message))
      feed.receive(example.baseline)
      const bridge = new RecordTreeSelection(feed, async () => { reads++; return example.answer },
        () => { throw new Error('selection cannot require recovery at the same R') }, e => errors.push(e))
      function Panel() {
        const state = useOrgRecords('fixture')!
        return <pre>{JSON.stringify(display(projectTree(state.records, {
          runtime: state.runtime, cursor: state.cursor })))}</pre>
      }
      const mounted = await mountView(<OrgRecordContext.Provider value={{ slug: 'fixture', session: feed }}>
        <Panel /></OrgRecordContext.Provider>, el => el.textContent)
      try {
        await inAct(async () => { bridge.set(example.selection); await Promise.resolve(); await Promise.resolve() })
        assert.deepEqual(feed.declarations().map(({ agents, windows }) => ({ agents, windows })), example.inputs, example.label)
        for (const page of example.pages) {
          const before = mounted.el.textContent
          await inAct(() => { feed.receiveSocket(page, token) })
          if (!page.final) assert.equal(mounted.el.textContent, before, 'non-final SQL page is not published')
        }
        await inAct(() => { feed.receiveSocket(example.runtime, token) })
        assert.deepEqual(JSON.parse(mounted.el.textContent!), display(hydrateTree(example.expected)), example.label)
        for (const update of example.changes ?? []) {
          await inAct(() => { feed.receiveSocket(update.frame, token); feed.receiveSocket(update.runtime, token) })
          assert.deepEqual(JSON.parse(mounted.el.textContent!), display(hydrateTree(update.expected)), example.label+' catch-up')
        }
        assert.equal(reads, 1, 'body edits do not rerun the one-shot selection query')
        assert.deepEqual(errors, [])
      } finally { await inAct(() => { bridge.dispose() }); await mounted.unmount(); feed.dispose() }
      const subscribed = messages.filter(m => m.type === 'subscribe').map(m => m.sub)
      assert.deepEqual(messages.filter(m => m.type === 'unsubscribe').map(m => m.sub), subscribed)
    }
  })
