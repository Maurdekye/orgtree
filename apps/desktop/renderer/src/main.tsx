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
import { startThemeSync } from './themes'
import { startContrastSync } from './contrast'
import { startAgentColorSync } from './agentcolors'

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
