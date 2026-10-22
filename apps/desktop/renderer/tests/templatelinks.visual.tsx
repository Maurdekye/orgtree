import { createRoot } from 'react-dom/client'
import { SaveTemplateModal } from '../src/canvas/templates'
import '../src/styles.css'

// Display-only fixture: no engine, providers, credentials, org data or network.
window.fetch = (async () => { throw new Error('offline capture fixture') }) as typeof fetch
createRoot(document.getElementById('root')!).render(<SaveTemplateModal slug="fixture" orgName="Development team" close={() => {}} />)
