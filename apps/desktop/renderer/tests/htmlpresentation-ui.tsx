// Fixture for htmlpresentation-capture.cjs: the org Presented documents panel
// against the capture's local server, with no fetch mock, so the real network
// stack and the desktop's session guard see every request the panel and its
// presentation frame make.
import { createRoot } from 'react-dom/client'
import { DocGalleryModal } from '../src/canvas/gallery'

createRoot(document.getElementById('root')!).render(<>
  <style>{'html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--text)}'}</style>
  <DocGalleryModal slug="synthetic-presentations" toast={() => {}} close={() => {}} />
</>)
