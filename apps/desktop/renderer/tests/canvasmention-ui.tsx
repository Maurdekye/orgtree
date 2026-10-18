import {createRoot} from 'react-dom/client'
import App from '../src/App'
import {installMentionFixture} from './canvasmention-fixture'
import '../src/styles.css'
import '../src/shell.css'
const mode=new URLSearchParams(location.search).get('view')==='attention'?'attention':'canvas'
const rig=installMentionFixture(mode)
document.documentElement.dataset.theme='dark'
;(window as unknown as {mentionFixture:typeof rig}).mentionFixture=rig
createRoot(document.getElementById('root')!).render(<App/> )
