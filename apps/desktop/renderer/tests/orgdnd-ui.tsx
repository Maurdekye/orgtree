import { createRoot } from 'react-dom/client'
import { SettingsPanel } from '../src/App'
import { orgDndTree, orgDndResponse } from './orgdnd-fixture'
import '../src/styles.css'
import '../src/shell.css'
globalThis.fetch = async url => new Response(JSON.stringify(orgDndResponse(String(url))), { status: 200 })
document.documentElement.dataset.theme = 'dark'
createRoot(document.getElementById('root')!).render(<SettingsPanel tree={orgDndTree} initialTab="mailserver" toast={() => {}} close={() => {}} />)
