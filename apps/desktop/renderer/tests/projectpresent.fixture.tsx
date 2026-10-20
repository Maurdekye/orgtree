import { ProjectSquare } from '../src/canvas/projectcard'
import { ProjectDesk } from '../src/canvas/projectdesk'
import type { CanvasNode, OpResult } from '../src/canvas/shared'
import type { TreePayload } from '../src/types'

const noop = () => {}
const op = async () => ({} as OpResult)
const doc = (id: string, title: string, hour: number) => ({ id, title, at: `2026-10-20T${hour}:00:00Z` })
const node = (id: string, documents: NonNullable<CanvasNode['documents']>, parent?: string) => ({
  id, title: id, kind: 'project', tier: 'project', state: 'live', parent, documents,
  documents_count: documents.length, children: [], scope: { tools: {}, add_dirs: [] },
  seat: 0, grant: 0, free: 0, lineage: [], turns: [], audiences_held: [], mail_pending: 0,
} as unknown as CanvasNode)

export function presentationChain() {
  const outer = node('outer-project', [doc('outer-plan', 'Outer plan', 10)])
  const middle = node('middle-project', [], outer.id)
  const leaf = node('leaf-project', [doc('leaf-4', 'Leaf report 4', 16), doc('leaf-3', 'Leaf report 3', 15),
    doc('leaf-2', 'Leaf report 2', 14), doc('leaf-1', 'Leaf report 1', 13)], middle.id)
  const author = { ...node('author', [doc('author-note', 'Agent notes', 17)], leaf.id), kind: 'agent', tier: 'sol', seat: 2 } as CanvasNode
  outer.children = [middle]; middle.children = [leaf]; leaf.children = [author]
  const projects = [outer, middle, leaf]
  const map = new Map([...projects, author].map((n) => [n.id, n]))
  const tree = { slug: 'project-doc-fixture', roots: [outer], watchdogs: [], slot_leases: [] } as unknown as TreePayload
  return { projects, author, map, tree }
}
type Chain = ReturnType<typeof presentationChain>

export function ProjectPresentationCards({ chain, onOpen = noop }: { chain: Chain; onOpen?: (id: string) => void }) {
  return <>{chain.projects.map((node) => <section data-project={node.id} key={node.id} className="project-card-case">
    <ProjectSquare node={node} pos={{ x: 0, y: 0 }} lod="norm" dragging={false} isDrop={false}
      op={op} slug="project-doc-fixture" toast={noop} zoom={1.2} hire={{}} seats={{}}
      tree={chain.tree} map={chain.map} onHire={noop} onNewProject={noop} onInbox={noop} onOpenDoc={onOpen}
      onDragStart={noop} onDragMove={noop} onDragEnd={noop} onDragCancel={noop} />
  </section>)}</>
}

export function ProjectPresentationHeaders({ chain, onOpen = noop }: { chain: Chain; onOpen?: (id: string) => void }) {
  return <>{chain.projects.map((node) => <section data-project={node.id} key={node.id} className="project-header-case">
    <ProjectDesk bare node={node} slug="project-doc-fixture" tree={chain.tree} map={chain.map}
      op={op} toast={noop} refs={{ world: { org: 'project-doc-fixture' }, onOpen: noop } as never} onOpenDoc={onOpen} />
  </section>)}</>
}
