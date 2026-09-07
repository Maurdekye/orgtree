import { createRoot } from 'react-dom/client'
import { MovableSurface, PopoutButton } from '../src/popout'
import '../src/styles.css'
createRoot(document.getElementById('root')!).render(<MovableSurface kind="stylesheet-fixture" title="Stylesheet fixture">
 <PopoutButton/><div className="styles-scroll"><input aria-label="Styles draft" defaultValue="kept"/><div style={{width:2200,height:2400}}>Wide and tall content</div></div>
</MovableSurface>)
