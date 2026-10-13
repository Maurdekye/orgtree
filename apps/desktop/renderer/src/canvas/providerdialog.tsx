import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ModalOverPins, PinFrame } from './modalpin'
import { useSurfaceDocument } from '../popout'

/** Provider drafts live above App settings, including when settings is pinned.
 * Closing discards the draft; an in-flight save must settle before dismissal. */
export function ProviderDialog({ title, busy, close, children }: {
  title: string
  busy: boolean
  close: () => void
  children: ReactNode
}) {
  const document = useSurfaceDocument()
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    content.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')?.focus()
    return () => { if (opener?.isConnected) opener.focus() }
  }, [opener])
  return <ModalOverPins>
    <PinFrame kind="provider-configuration" title={title} dialogLabel={title}
      panel="settings content-height provider-dialog" pinnable={false}
      close={() => { if (!busy) close() }}>
      <h3>{title}</h3>
      <div ref={content}>{children}</div>
    </PinFrame>
  </ModalOverPins>
}
