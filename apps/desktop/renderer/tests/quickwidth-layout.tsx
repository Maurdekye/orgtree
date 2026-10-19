// Browser-only geometry fixture: jsdom cannot reproduce a ResizeObserver loop.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useEqualSides } from '../src/shell/equalsides'
import { ShellHeader } from '../src/shell/header'
import { applyTheme } from '../src/themes'

const fakeDesktop = {
  getWindowControlsState: async () => ({ maximized: false }),
  getUpdateStatus: async () => ({ state: 'idle' }),
  onEvent: () => () => {},
}
Object.assign(window, { orgtreeDesktop: fakeDesktop })
applyTheme('dark')
const style = document.createElement('style')
style.textContent = 'body{display:block;margin:0;padding:12px;overflow:hidden}h4{margin:12px 0 4px;font:12px system-ui;color:var(--dim)}.case{border:1px solid var(--line)}'
document.head.append(style)
const root = createRoot(document.getElementById('root')!)
function Footer() {
  const refs = useEqualSides(true)
  return <footer ref={refs.head} className="shell-statusbar shell-statusbar-centred">
    <div ref={refs.start} className="shell-statusbar-start"><div className="shell-statusbar-chips"><span className="chip">4 agents</span><span className="chip">local hub connected</span></div></div>
    <div className="shell-statusbar-quick"><input placeholder="Quick chat in footer" /></div>
    <div ref={refs.end} className="shell-statusbar-end"><span className="shell-version">Orgtree 4.3.3</span></div>
  </footer>
}
function render(width: number, changed = false) {
  const titles = ['Orgtree', 'A longer organization name', 'A very long organization name with a logo or translated controls']
  flushSync(() => root.render(<>
    {titles.map((title, i) => <section key={i} data-case={`header-${i}`}>
      <h4>{width}px · {title}</h4><div className="case" style={{width}}>
        <ShellHeader title={changed ? title + ' changed' : title}
          menu={<button className="shell-menu-button">☰</button>}
          modes={<button>{changed ? 'Attention' : 'Canvas'}</button>}
          quick={<div className="quickchat"><input className="quickchat-input" placeholder="Quick chat"/><button className="quickchat-btn">Model</button><button className="quickchat-btn">Send</button></div>}
          guard={<button className="kill-latch">{changed ? 'STOP ALL' : '!'}</button>}
          actions={<><button>W</button><button>I</button><button>P</button><button>S</button></>} />
      </div>
    </section>)}
    <section data-case="footer"><h4>{width}px · footer control</h4><div className="case" style={{width}}><Footer/></div></section>
  </>))
}
Object.assign(window, { quickWidthFixture: render })
render(1024)
