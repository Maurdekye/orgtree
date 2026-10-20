import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { Panel, fallback, tree, transport } from './docketmembership.fixture'
import { treeSelections } from '../src/treeselection'
window.fetch = transport()
const stats = { reads: 0, renders: 0 }
let answer: () => void
function View() {
  const [tr, setTree] = useState(tree)
  ++stats.renders
  answer = () => setTree(tree(treeSelections.read('membership-test', fallback).selection.include))
  useEffect(() => treeSelections.subscribe(org => { if (org === 'membership-test') ++stats.reads }), [])
  return <Panel tr={tr} />
}
Object.assign(window, { membershipAnswer: () => answer(), membershipStats: () => stats })
createRoot(document.getElementById('root')!).render(<View />)
