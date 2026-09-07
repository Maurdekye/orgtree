import React from 'react'
import { reportCrash } from './crashReporter'

interface State { error: Error | null }

/** Deliberately dependency-free rendering here: any component the fallback
 *  pulls in (MUI, icons, styled) is one more thing that can fail on the same
 *  render that is already failing. Plain elements, inline styles only.
 *
 *  A crash INSIDE this fallback's own render has no boundary above it to
 *  catch it (a component's error-boundary methods only catch errors from its
 *  CHILDREN, never from its own render) — that case is covered instead by the
 *  window 'error' listener registered in crashReporter.ts, which is why that
 *  module is imported before React even starts. __crashTestFallback proves it
 *  (see crashReporter.ts's manual test hooks). */
export default class CrashBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportCrash({
      kind: 'react-boundary',
      message: error.message || String(error),
      stack: error.stack || String(error),
      componentStack: info.componentStack || undefined,
    })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      if ((window as unknown as Record<string, boolean>).__crashTestFallback) {
        throw new Error('crash-test: fallback render failure')
      }
      return (
        <div
          data-testid="crash-fallback"
          style={{
            padding: 32, fontFamily: 'monospace', color: '#eee',
            background: '#1a1a1a', minHeight: '100vh', boxSizing: 'border-box',
          }}
        >
          <h2 style={{ color: '#f66', margin: '0 0 12px' }}>orgtree hit a problem and had to stop.</h2>
          <p style={{ margin: '0 0 8px' }}>
            A crash report was saved and sent automatically — no action needed to preserve it.
          </p>
          <p style={{ opacity: 0.6, fontSize: 13, whiteSpace: 'pre-wrap' }}>{this.state.error.message}</p>
          <button
            onClick={() => location.reload()}
            style={{
              marginTop: 16, padding: '8px 16px', background: '#333', color: '#eee',
              border: '1px solid #555', borderRadius: 4, cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

/** Render-phase test trigger, kept out of App.tsx entirely (additive-only) —
 *  mounted as a sibling of App inside CrashBoundary in main.tsx. */
export function CrashTestRenderTrigger(): null {
  if ((window as unknown as Record<string, boolean>).__crashTestRender) {
    throw new Error('crash-test: render failure')
  }
  return null
}
