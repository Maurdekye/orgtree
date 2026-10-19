import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { EventCard } from '../src/events/card'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'

const event = {
  v: 1,
  variant: 'monitor.watchdog_fired',
  actor: { kind: 'watchdog', id: 'worker/smoke3-watch' },
  engine_authored: true,
  object: { kind: 'watchdog', org: 'synthetic', id: 'worker/smoke3-watch', name: 'smoke3-watch', owner: 'worker' },
  prefix: '^READY$',
  lines: ['READY'],
  count: 1,
  once: true,
}
const noop = () => {}
const root = createRoot(document.getElementById('root')!)
flushSync(() => root.render(
  <ObjectNavProvider>
    <ObjectNavHost org="synthetic" dogs={[]} openDog={noop} toast={noop} />
    <DeskDogsProvider value={{ org: 'synthetic', dogs: [], open: noop }}>
      <main style={{ padding: 24, width: 920 }}>
        <h2>Monitor event</h2>
        <p>The watchdog fired as a one-shot and has left the live watchdog list.</p>
        <ObjectMenuBoundary>
          <EventCard org="synthetic" profile="operator" row={{ ev: event, body: '[WATCHDOG smoke3-watch] READY' }} preview />
        </ObjectMenuBoundary>
      </main>
    </DeskDogsProvider>
  </ObjectNavProvider>,
))
document.body.dataset.ready = 'true'
