import type { DocRow } from '../src/api'

export const galleryRows: DocRow[] = [
  { id:'plain', node:'coordinator-opus', title:'Project slots: UI/UX mockups', tier:'opus', format:'html' },
  { id:'project', node:'test-project', title:'Hello from test-proj-worker-c', tier:'project', presented_by:'test-proj-worker-c', presenter_tier:'sol' },
  { id:'long', node:'test-project-with-a-very-long-name-that-must-stay-on-one-line', title:'A presentation with long attribution', tier:'project', presented_by:'test-proj-worker-with-a-very-long-name-that-needs-truncation', presenter_tier:'sol' },
  { id:'another', node:'coordinator-opus', title:'Project slots: how they would work', tier:'opus' },
].map((r) => ({ at:'2026-10-18T08:00:00Z', evicted:false, node_state:'live', format:'markdown', bytes:120, ...r })) as DocRow[]

export function installGalleryFixture() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url)
    const match = path.match(/\/documents\/([^/?]+)$/)
    const row = galleryRows.find(r => r.id === match?.[1])
    const data = match ? { ...row, body:'# Synthetic presentation\n\nPresentation content and project attribution remain unchanged.' }
      : {documents:galleryRows, total:galleryRows.length, next_offset:null}
    return {ok:true, status:200, headers:new Headers(), json:async()=>data} as Response
  }) as typeof fetch
}
