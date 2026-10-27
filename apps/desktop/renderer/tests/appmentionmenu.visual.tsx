import {createRoot} from 'react-dom/client'
import {MentionMenuFixture,mentionMenuEngine} from './appmentionmenu.fixture'
import '../src/styles.css'
mentionMenuEngine()
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px system-ui'
const style=document.createElement('style');style.textContent='.mention-menu-fixture{margin:80px auto 0;width:700px;padding:22px 30px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}.mention-menu-fixture h2{font-size:18px;margin:0 0 20px}.mention-menu-fixture p{margin:0;line-height:2}';document.head.append(style)
createRoot(document.getElementById('root')!).render(<><MentionMenuFixture slug="capture-react"/><MentionMenuFixture slug="capture-md" markdown/></>)
