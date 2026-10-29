import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { applyTheme } from '../src/themes'
import { DeskDogsProvider } from '../src/canvas/deskdogs'
import { ObjectNavProvider } from '../src/canvas/objectnav'
import { ObjectNavHost } from '../src/canvas/objectnavhost'
import { ObjectMenuBoundary } from '../src/canvas/contextmenu'
import { ToolRefs } from '../src/canvas/toolrefs'
import { EventCard } from '../src/events/card'
import type { Watchdog } from '../src/types'
import type { KnownEvent } from '../src/events/types'

declare global {
  interface Window {
    __watchdogChipsSettled?: boolean
  }
}

const fixedNow = 1_800_000_000_000
Date.now = () => fixedNow
localStorage.clear()
applyTheme('dark')

const liveDog: Watchdog = {
  id: 'worker/build-monitor',
  owner: 'worker',
  name: 'build-monitor',
  kind: 'command',
  target: 'echo build heartbeat',
  once: false,
  state: 'armed',
  spent: false,
  at: '2026-10-29T23:00:00.000Z',
  fired: 2,
  interval_s: 60,
  next_check_at: new Date(fixedNow + 60_000).toISOString(),
}

const fireEvent = (id: string, name: string, line: string, once: boolean): KnownEvent => ({
  v: 1,
  variant: 'monitor.watchdog_fired',
  engine_authored: true,
  actor: { kind: 'watchdog', id },
  object: { kind: 'watchdog', org: 'demo', id, owner: 'worker', name },
  prefix: 'WATCHDOG',
  lines: [line],
  once,
  count: 1,
})

const noop = () => {}

function Fixture() {
  const dogs = [liveDog]
  return (
    <ObjectNavProvider>
      <ObjectNavHost org="demo" dogs={dogs} openDog={noop} toast={noop} />
      <DeskDogsProvider value={{ org: 'demo', dogs, open: noop }}>
        <ObjectMenuBoundary>
          <main
            style={{
              padding: '20px 24px',
              background: 'var(--bg)',
              color: 'var(--ink)',
              minHeight: '100vh',
              boxSizing: 'border-box',
              fontFamily: 'var(--sans, system-ui, sans-serif)',
            }}
          >
            <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>
              Watchdog Chip Symmetry — Tool-call Row vs Monitor Event Card
            </h2>
            <p className="dim" style={{ margin: '0 0 16px', fontSize: 12 }}>
              Top row: gone one-shot watchdog (<code>marchpup-full-sdk</code>, absent from <code>route.dogs</code>).
              Bottom row: live armed watchdog (<code>build-monitor</code>, present in <code>route.dogs</code>).
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '16px',
                alignItems: 'start',
              }}
            >
              <section
                id="gone-tool"
                data-case="gone-tool"
                style={{
                  padding: '12px 14px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--panel)',
                }}
              >
                <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
                  Gone dog · orgtree_watchdog tool-call row
                </div>
                <div className="tools tchip">
                  <span className="tline">
                    <span className="tooldot">●</span>{' '}
                    orgtree_watchdog
                    <span className="targ"> create</span>
                    <ToolRefs
                      refs={[{ kind: 'watchdog', id: 'marchpup-full-sdk' }]}
                      owner="worker"
                      org="demo"
                      agent={id => id}
                    />
                  </span>
                </div>
              </section>

              <section
                id="gone-card"
                data-case="gone-card"
                style={{
                  padding: '12px 14px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--panel)',
                }}
              >
                <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
                  Gone dog · Monitor event card
                </div>
                <EventCard
                  org="demo"
                  profile="operator"
                  row={{
                    ev: fireEvent(
                      'worker/marchpup-full-sdk',
                      'marchpup-full-sdk',
                      'Marchpup SDK build finished',
                      true,
                    ),
                    body: 'Marchpup SDK build finished',
                  }}
                  preview
                />
              </section>

              <section
                id="live-tool"
                data-case="live-tool"
                style={{
                  padding: '12px 14px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--panel)',
                }}
              >
                <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
                  Live dog · orgtree_watchdog tool-call row
                </div>
                <div className="tools tchip">
                  <span className="tline">
                    <span className="tooldot">●</span>{' '}
                    orgtree_watchdog
                    <span className="targ"> create</span>
                    <ToolRefs
                      refs={[{ kind: 'watchdog', id: 'build-monitor' }]}
                      owner="worker"
                      org="demo"
                      agent={id => id}
                    />
                  </span>
                </div>
              </section>

              <section
                id="live-card"
                data-case="live-card"
                style={{
                  padding: '12px 14px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--panel)',
                }}
              >
                <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
                  Live dog · Monitor event card
                </div>
                <EventCard
                  org="demo"
                  profile="operator"
                  row={{
                    ev: fireEvent(
                      liveDog.id,
                      liveDog.name,
                      'Build monitor heartbeat',
                      false,
                    ),
                    body: 'Build monitor heartbeat',
                  }}
                  preview
                />
              </section>
            </div>
          </main>
        </ObjectMenuBoundary>
      </DeskDogsProvider>
    </ObjectNavProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__watchdogChipsSettled = true
  })
})
