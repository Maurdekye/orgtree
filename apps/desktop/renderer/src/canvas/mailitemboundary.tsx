// ⚠ ONE MESSAGE MUST NEVER TAKE THE WINDOW DOWN (user bug 2026-10-29: one
// org-inbox message whose sender rendered as nothing stopped the whole
// frontend, because the app-wide CrashBoundary was the only boundary above a
// mailbox). A list row or a reading pane that throws while rendering ends
// here instead: it says that one message could not be shown, the mailbox
// around it keeps working, and the same crash report is still filed, so the
// fault is found rather than hidden.
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

// ONE REPORT PER DISTINCT FAILURE for the life of the page: reopening the
// message, its folder or the panel meets the same failure in a fresh
// boundary, and a folder of messages broken the same way is one fault, not
// one per row
const reported = new Set<string>()

interface Props {
  /** the reading pane's body; otherwise one list row */
  pane?: boolean
  children: ReactNode
}

/** Key it by the message it holds: a different message starts it afresh. */
export class MailItemBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const e = error instanceof Error ? error : null
    const message = e?.message || String(error)
    const signature = `${message}\n${info.componentStack ?? ''}`
    if (reported.has(signature)) return
    reported.add(signature)
    const report = { kind: 'react-boundary' as const, message, stack: e?.stack || message,
      componentStack: info.componentStack || undefined }
    // LOADED HERE, NEVER IMPORTED: the crash reporter installs window
    // listeners, a route poll and a console.error patch as it loads. The app
    // loads it first (main.tsx), so this is that same module at once; a
    // static import would run all of it wherever the mailbox is imported, and
    // a test without a DOM would fail to load ("window is not defined").
    import('../crashReporter').then((m) => { m.reportCrash(report) },
      (failure: unknown) => console.error('MailItemBoundary: crash report not filed', failure, report))
  }

  // plain elements only, like CrashBoundary's fallback: nothing here can fail
  // the way the message did
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return this.props.pane
      ? <div className="dim pad mail-item-error" role="alert">
          This message could not be shown. A crash report was saved.
        </div>
      : <div className="mailrow mail-item-error" role="alert">This message could not be shown.</div>
  }
}

/** Runs `render` as this component's own render, so a throw from it lands on
 *  the nearest boundary below the caller instead of failing the caller's
 *  render (MailList passes each row's caller-supplied renderers through it). */
export function Rendered({ render }: { render: () => ReactNode }) {
  return <>{render()}</>
}
