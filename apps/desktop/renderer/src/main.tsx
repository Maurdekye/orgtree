// MUST be the first import: its top-level code (window error/rejection
// listeners) must be live before anything else — including React itself —
// gets a chance to throw. See crashReporter.ts for why.
import { flushPendingReports } from './crashReporter'
import React from 'react'
import ReactDOM from 'react-dom/client'
import './mobile'   // D-125: stamp html.mobile before first paint
import App from './App'
import CrashBoundary, { CrashTestRenderTrigger } from './CrashBoundary'
import { installFreezeLog } from './freezelog'
import FreezeLogPage, { isFreezeLogPath } from './FreezeLogPage'
import './styles.css'
// the v3 shell's own sheet, deliberately separate from styles.css and loaded
// after it so a shell rule can layer over a shared one (see shell.css)
import './shell.css'
import { startThemeSync } from './themes'
import { startContrastSync } from './contrast'
import { startAgentColorSync } from './agentcolors'
import { startHeldEvents } from './events/heldbus'

// ⚠ FIRST, AND BEFORE EVERY OTHER `onEvent` SUBSCRIPTION IN THIS DOCUMENT.
// The preload sends `desktop:events-listening` from inside `onEvent`, so
// whichever subscription attaches first is what ends native's holding — and
// whatever native then sends reaches only the listeners that already exist.
// `startThemeSync` below would otherwise be that first listener, and it cares
// about `preferences` alone: the four held types would be delivered, on time
// and correctly, to a document whose consumers for them are React effects that
// have not run yet. This keeps them instead. See events/heldbus.ts.
startHeldEvents()

startThemeSync()
startContrastSync()
startAgentColorSync()

flushPendingReports()

// /debug/freezes shows the freeze log instead of the app; every other path
// runs the app with the recorder installed (see freezelog.ts)
const freezePage = isFreezeLogPath()
if (!freezePage) installFreezeLog()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CrashBoundary>
      <CrashTestRenderTrigger />
      {freezePage ? <FreezeLogPage /> : <App />}
    </CrashBoundary>
  </React.StrictMode>,
)
